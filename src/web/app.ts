import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ClientMsg, ServerMsg, SessionMeta, SessionStatus } from '../shared/protocol.js';
import { playChime, unlockAudio } from './chimes.js';
import { ensurePermission, notify } from './notify.js';
import {
  BIN_PTY_DATA,
  BIN_PTY_INPUT,
  BIN_HEADER_SIZE,
  uuidToBytes,
  bytesToUuid,
} from '../shared/binProtocol.js';

interface TabState {
  meta: SessionMeta;
  term: Terminal;
  fit: FitAddon;
  tabEl: HTMLDivElement;
  paneEl: HTMLDivElement;
}

const tabs = new Map<string, TabState>();
let activeId: string | null = null;

const LS_KEYS = {
  lastRepo: 'cm.lastRepoPath',
  chimesEnabled: 'cm.chimesEnabled',
  notifyEnabled: 'cm.notifyEnabled',
} as const;

function lsGet(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key: string, val: string): void { try { localStorage.setItem(key, val); } catch { /* ignore */ } }

let chimesEnabled = lsGet(LS_KEYS.chimesEnabled) !== 'false';
let notifyEnabled = lsGet(LS_KEYS.notifyEnabled) !== 'false';

const tabsEl = document.getElementById('tabs') as HTMLDivElement;
const panesEl = document.getElementById('panes') as HTMLDivElement;
const newBtn = document.getElementById('new-session') as HTMLButtonElement;
const connEl = document.getElementById('conn-state') as HTMLSpanElement;

const utf8Encoder = new TextEncoder();

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  connEl.textContent = 'connecting…';
  ws.onopen = () => {
    connEl.textContent = 'connected';
    connEl.style.color = 'var(--green)';
  };
  ws.onmessage = (evt) => {
    if (evt.data instanceof ArrayBuffer) {
      handleBinaryMsg(new Uint8Array(evt.data));
      return;
    }
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

function sendPtyInputBinary(sessionId: string, payload: Uint8Array): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const frame = new Uint8Array(BIN_HEADER_SIZE + payload.length);
  frame[0] = BIN_PTY_INPUT;
  uuidToBytes(sessionId, frame, 1);
  frame.set(payload, BIN_HEADER_SIZE);
  ws.send(frame);
}

function handleBinaryMsg(buf: Uint8Array): void {
  if (buf.length < BIN_HEADER_SIZE) return;
  const tag = buf[0];
  if (tag === BIN_PTY_DATA) {
    const sessionId = bytesToUuid(buf, 1);
    const t = tabs.get(sessionId);
    if (t) {
      // xterm.js write accepts Uint8Array; we slice (zero-copy view) the payload.
      t.term.write(buf.subarray(BIN_HEADER_SIZE));
    }
  }
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
      // Legacy JSON path — server prefers binary frames now. Decode for safety.
      const t = tabs.get(msg.id);
      if (t) {
        const bin = atob(msg.data);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        t.term.write(arr);
      }
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
    empty.querySelector('#empty-new')?.addEventListener('click', () => openNewSessionModal());
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
    label.textContent = meta.title ?? meta.branch ?? meta.id.slice(0, 8);
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
      sendPtyInputBinary(meta.id, utf8Encoder.encode(data));
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
  const prev = t.meta.status;
  t.meta.status = status;
  t.tabEl.dataset.status = status;

  // Chime + notify only on meaningful transitions, and only when the tab is
  // not the currently-focused one (otherwise it's just noise).
  if (prev === status) return;
  const isActiveTab = id === activeId && document.visibilityState === 'visible' && document.hasFocus();

  let kind: 'needs-input' | 'done' | 'error' | null = null;
  if (status === 'needs-input' && prev !== 'needs-input') kind = 'needs-input';
  else if (status === 'error' && prev !== 'error') kind = 'error';
  else if (status === 'idle' && (prev === 'working' || prev === 'spawning')) kind = 'done';

  if (kind && !isActiveTab) {
    if (chimesEnabled) playChime(kind);
    if (notifyEnabled) notify(kind, t.meta.title ?? t.meta.branch ?? null);
  }
}

function newSession(opts?: { cwd?: string; repoPath?: string; branchName?: string }) {
  sendMsg({ t: 'session.new', ...opts });
}

// ─────────────────────────── new-session modal ─────────────────────────────

function openNewSessionModal(): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const lastRepo = lsGet(LS_KEYS.lastRepo) ?? '';
  overlay.innerHTML = `
    <div class="modal">
      <h2>new copilot session</h2>
      <label>
        <span>repo path <em>(blank = use server cwd, no worktree)</em></span>
        <input id="cm-repo" type="text" placeholder="/Users/you/repos/yourrepo" value="${escapeHtml(lastRepo)}" autofocus />
        <span class="repo-status" id="cm-repo-status"></span>
      </label>
      <label>
        <span>branch off from <em>(base branch — your new branch will fork from this)</em></span>
        <select id="cm-base" disabled>
          <option value="">(enter a repo path first)</option>
        </select>
      </label>
      <label>
        <span>new branch name <em>(blank = auto <code>copilot/&lt;id&gt;</code>)</em></span>
        <input id="cm-branch" type="text" placeholder="copilot/my-feature" />
      </label>
      <p class="hint">a fresh git worktree on the new branch is created under <code>~/.copilot-multi/wt/&lt;id&gt;/</code>. your main checkout is never touched. uncommitted work in the session worktree is auto-committed to its branch on exit — branches always persist.</p>
      <div class="modal-actions">
        <button class="ghost" id="cm-cancel">cancel</button>
        <button class="primary" id="cm-ok">spawn</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  unlockAudio();
  ensurePermission();

  const repoInput = overlay.querySelector('#cm-repo') as HTMLInputElement;
  const baseSelect = overlay.querySelector('#cm-base') as HTMLSelectElement;
  const branchInput = overlay.querySelector('#cm-branch') as HTMLInputElement;
  const repoStatus = overlay.querySelector('#cm-repo-status') as HTMLSpanElement;

  let lastFetchToken = 0;
  async function refreshBranches(path: string) {
    const token = ++lastFetchToken;
    if (!path.trim()) {
      baseSelect.innerHTML = '<option value="">(enter a repo path first)</option>';
      baseSelect.disabled = true;
      repoStatus.textContent = '';
      return;
    }
    repoStatus.textContent = 'checking…';
    repoStatus.className = 'repo-status checking';
    try {
      const url = `/api/repo/branches?path=${encodeURIComponent(path)}`;
      const r = await fetch(url);
      if (token !== lastFetchToken) return; // stale
      const data = await r.json() as { ok: boolean; error?: string; repoPath?: string; branches?: string[]; current?: string };
      if (!data.ok) {
        baseSelect.innerHTML = '<option value="">(not a git repo — no worktree)</option>';
        baseSelect.disabled = true;
        repoStatus.textContent = data.error ?? 'not a git repo';
        repoStatus.className = 'repo-status warn';
        return;
      }
      const branches = data.branches ?? [];
      const current = data.current ?? '';
      baseSelect.innerHTML = branches.map((b) =>
        `<option value="${escapeHtml(b)}"${b === current ? ' selected' : ''}>${escapeHtml(b)}${b === current ? '  (current)' : ''}</option>`
      ).join('');
      baseSelect.disabled = false;
      repoStatus.textContent = `✓ git repo at ${data.repoPath} — ${branches.length} branch${branches.length === 1 ? '' : 'es'}`;
      repoStatus.className = 'repo-status ok';
    } catch (e) {
      if (token !== lastFetchToken) return;
      repoStatus.textContent = 'check failed: ' + (e as Error).message;
      repoStatus.className = 'repo-status warn';
    }
  }
  // Debounced fetch on input
  let debounceTimer: number | null = null;
  repoInput.addEventListener('input', () => {
    if (debounceTimer != null) clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => refreshBranches(repoInput.value), 300);
  });
  // Initial fetch if we have a remembered repo
  if (lastRepo) refreshBranches(lastRepo);

  const cleanup = () => overlay.remove();
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) cleanup(); });
  overlay.querySelector('#cm-cancel')!.addEventListener('click', cleanup);

  const submit = () => {
    const repo = repoInput.value.trim();
    const base = baseSelect.value.trim();
    const branch = branchInput.value.trim();
    const opts: { repoPath?: string; cwd?: string; branchName?: string; baseBranch?: string } = {};
    if (repo) {
      opts.repoPath = repo;
      opts.cwd = repo;
      lsSet(LS_KEYS.lastRepo, repo);
    }
    if (base) opts.baseBranch = base;
    if (branch) opts.branchName = branch;
    cleanup();
    newSession(opts);
  };
  overlay.querySelector('#cm-ok')!.addEventListener('click', submit);
  overlay.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.target as HTMLElement).tagName !== 'SELECT') {
      ev.preventDefault();
      submit();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      cleanup();
    }
  });
  repoInput.focus();
  repoInput.setSelectionRange(repoInput.value.length, repoInput.value.length);
}

newBtn.addEventListener('click', () => { unlockAudio(); openNewSessionModal(); });

document.addEventListener('keydown', (ev) => {
  const meta = ev.metaKey || ev.ctrlKey;
  if (!meta) return;
  if (ev.key === 't' || ev.key === 'T') {
    ev.preventDefault();
    openNewSessionModal();
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

// Settings toggles in the footer (chimes / notifications)
function wireSettings(): void {
  const chimeBtn = document.getElementById('toggle-chimes') as HTMLButtonElement | null;
  const notifyBtn = document.getElementById('toggle-notify') as HTMLButtonElement | null;
  const sync = () => {
    if (chimeBtn) chimeBtn.dataset.on = chimesEnabled ? '1' : '0';
    if (notifyBtn) notifyBtn.dataset.on = notifyEnabled ? '1' : '0';
  };
  chimeBtn?.addEventListener('click', () => {
    chimesEnabled = !chimesEnabled;
    lsSet(LS_KEYS.chimesEnabled, String(chimesEnabled));
    sync();
    if (chimesEnabled) playChime('done');
  });
  notifyBtn?.addEventListener('click', () => {
    notifyEnabled = !notifyEnabled;
    lsSet(LS_KEYS.notifyEnabled, String(notifyEnabled));
    sync();
    if (notifyEnabled) ensurePermission();
  });
  sync();
}
wireSettings();

connect();
renderEmpty();
