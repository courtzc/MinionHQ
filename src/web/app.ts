import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ClientMsg, ServerMsg, SessionMeta, SessionStatus } from '../shared/protocol.js';

interface TabState {
  meta: SessionMeta;
  term: Terminal;
  fit: FitAddon;
  tabEl: HTMLDivElement;
  paneEl: HTMLDivElement;
}

const tabs = new Map<string, TabState>();
let activeId: string | null = null;

const tabsEl = document.getElementById('tabs') as HTMLDivElement;
const panesEl = document.getElementById('panes') as HTMLDivElement;
const newBtn = document.getElementById('new-session') as HTMLButtonElement;
const connEl = document.getElementById('conn-state') as HTMLSpanElement;

function b64encode(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  connEl.textContent = 'connecting…';
  ws.onopen = () => {
    connEl.textContent = 'connected';
    connEl.style.color = 'var(--green)';
  };
  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data) as ServerMsg;
      handleServerMsg(msg);
    } catch (e) {
      console.warn('bad ws msg', e);
    }
  };
  ws.onclose = () => {
    connEl.textContent = 'disconnected — retrying…';
    connEl.style.color = 'var(--red)';
    if (reconnectTimer == null) {
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 1500);
    }
  };
  ws.onerror = () => {
    // onclose will follow
  };
}

function sendMsg(msg: ClientMsg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}

function handleServerMsg(msg: ServerMsg) {
  switch (msg.t) {
    case 'hello':
      // protocol version handshake (Phase 1: just log)
      console.log('server protocol', msg.protocolVersion);
      break;
    case 'session.list':
      for (const m of msg.sessions) ensureTab(m, false);
      if (msg.sessions.length === 0 && activeId == null) renderEmpty();
      break;
    case 'session.created':
      ensureTab(msg.session, true);
      break;
    case 'session.status':
      updateStatus(msg.id, msg.status);
      break;
    case 'pty.data': {
      const t = tabs.get(msg.id);
      if (t) t.term.write(b64decode(msg.data));
      break;
    }
    case 'pty.exit': {
      const t = tabs.get(msg.id);
      if (t) {
        t.term.writeln(`\r\n\x1b[2m[process exited code=${msg.code} signal=${msg.signal}]\x1b[0m`);
        updateStatus(msg.id, 'exited');
      }
      break;
    }
    case 'error':
      console.error('server error:', msg.message);
      if (msg.id) {
        const t = tabs.get(msg.id);
        if (t) t.term.writeln(`\r\n\x1b[31m[error] ${msg.message}\x1b[0m`);
      }
      break;
  }
}

function renderEmpty() {
  panesEl.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.innerHTML = `
    <div>no sessions yet</div>
    <button id="empty-new">spawn a copilot session</button>
    <div style="font-size:11px; color: var(--fg-dim)">cwd: <code>${escapeHtml(getDefaultCwd())}</code></div>
  `;
  panesEl.appendChild(empty);
  empty.querySelector('#empty-new')?.addEventListener('click', () => newSession());
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function getDefaultCwd(): string {
  // The browser doesn't actually know the server cwd; server falls back to process.cwd().
  const param = new URLSearchParams(location.search).get('cwd');
  return param ?? '(server cwd)';
}

function ensureTab(meta: SessionMeta, makeActive: boolean) {
  let t = tabs.get(meta.id);
  if (!t) {
    // tab element
    const tabEl = document.createElement('div');
    tabEl.className = 'tab';
    tabEl.dataset.id = meta.id;
    tabEl.dataset.status = meta.status;
    const dot = document.createElement('span');
    dot.className = 'dot';
    const label = document.createElement('span');
    label.textContent = meta.title ?? meta.id.slice(0, 8);
    label.className = 'label';
    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '×';
    close.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (confirm('close session?')) sendMsg({ t: 'session.close', id: meta.id });
    });
    tabEl.append(dot, label, close);
    tabEl.addEventListener('click', () => activate(meta.id));
    tabsEl.appendChild(tabEl);

    // remove empty splash if present
    const empty = panesEl.querySelector('.empty');
    if (empty) empty.remove();

    // pane
    const paneEl = document.createElement('div');
    paneEl.className = 'pane';
    paneEl.dataset.id = meta.id;
    const termWrap = document.createElement('div');
    termWrap.className = 'term-wrap';
    paneEl.appendChild(termWrap);
    panesEl.appendChild(paneEl);

    const term = new Terminal({
      convertEol: false,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      theme: {
        background: '#000000',
        foreground: '#e6edf3',
        cursor: '#2f81f7',
      },
      allowProposedApi: true,
      scrollback: 10000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termWrap);
    fit.fit();

    term.onData((data) => {
      sendMsg({ t: 'pty.input', id: meta.id, data: b64encode(data) });
    });
    term.onResize(({ cols, rows }) => {
      sendMsg({ t: 'pty.resize', id: meta.id, cols, rows });
    });

    t = { meta, term, fit, tabEl, paneEl };
    tabs.set(meta.id, t);

    // attach is implicit on session.created (server auto-attaches); for pre-existing list, send attach
    if (!makeActive) {
      sendMsg({ t: 'session.attach', id: meta.id });
    }

    // refit on container resize
    new ResizeObserver(() => {
      try { t!.fit.fit(); } catch { /* ignore */ }
    }).observe(termWrap);
  }
  if (makeActive) activate(meta.id);
}

function activate(id: string) {
  if (activeId === id) return;
  activeId = id;
  for (const [tid, t] of tabs) {
    const isActive = tid === id;
    t.tabEl.classList.toggle('active', isActive);
    t.paneEl.classList.toggle('active', isActive);
    if (isActive) {
      try { t.fit.fit(); } catch { /* ignore */ }
      setTimeout(() => t.term.focus(), 0);
    }
  }
}

function updateStatus(id: string, status: SessionStatus) {
  const t = tabs.get(id);
  if (!t) return;
  t.meta.status = status;
  t.tabEl.dataset.status = status;
}

function newSession(cwd?: string) {
  sendMsg({ t: 'session.new', cwd });
}

newBtn.addEventListener('click', () => newSession());

document.addEventListener('keydown', (ev) => {
  const meta = ev.metaKey || ev.ctrlKey;
  if (!meta) return;
  if (ev.key === 't' || ev.key === 'T') {
    ev.preventDefault();
    newSession();
  } else if (ev.key === 'w' || ev.key === 'W') {
    if (activeId) {
      ev.preventDefault();
      if (confirm('close session?')) sendMsg({ t: 'session.close', id: activeId });
    }
  } else if (/^[1-9]$/.test(ev.key)) {
    const idx = Number(ev.key) - 1;
    const ids = [...tabs.keys()];
    if (ids[idx]) {
      ev.preventDefault();
      activate(ids[idx]);
    }
  }
});

connect();
renderEmpty();
