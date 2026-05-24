import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ClientMsg, ServerMsg, SessionMeta, SessionStatus } from '../shared/protocol.js';
import { playChime, unlockAudio } from './chimes.js';
import { ensurePermission, notify } from './notify.js';
import { colorForRepo } from './repoColors.js';
import { AlertDispatcher } from './alertDispatcher.js';
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
  loadingEl: HTMLDivElement;
  firstByteSeen: boolean;
}

const tabs = new Map<string, TabState>();
let activeId: string | null = null;

// Pop-out mode: when the URL has ?pop=<sessionId>, this window renders just
// that one session (no tab bar, no actions) so it can live on its own monitor.
const POPOUT_ID = new URLSearchParams(location.search).get('pop');
const IS_POPOUT = !!POPOUT_ID;
if (IS_POPOUT) document.body.classList.add('popout');

const LS_KEYS = {
  lastRepo: 'cm.lastRepoPath',
  lastReposBase: 'cm.lastReposBase',
  chimesEnabled: 'cm.chimesEnabled',
  notifyEnabled: 'cm.notifyEnabled',
  activeId: 'cm.activeTab',
  tabTitles: 'cm.tabTitles',
} as const;

function lsGet(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key: string, val: string): void { try { localStorage.setItem(key, val); } catch { /* ignore */ } }
function lsRemove(key: string): void { try { localStorage.removeItem(key); } catch { /* ignore */ } }

function readTitleMap(): Record<string, string> {
  try { return JSON.parse(lsGet(LS_KEYS.tabTitles) ?? '{}'); } catch { return {}; }
}
function writeTitleMap(map: Record<string, string>): void {
  lsSet(LS_KEYS.tabTitles, JSON.stringify(map));
}
function getCustomTitle(id: string): string | null {
  const v = readTitleMap()[id];
  return typeof v === 'string' && v.trim() ? v : null;
}
function setCustomTitle(id: string, title: string | null): void {
  const map = readTitleMap();
  if (title && title.trim()) map[id] = title.trim();
  else delete map[id];
  writeTitleMap(map);
}

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
      // First byte of PTY data means the session is live — drop the loader.
      if (!t.firstByteSeen) {
        t.firstByteSeen = true;
        t.loadingEl.dataset.hidden = '1';
      }
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
      for (const m of msg.sessions) {
        // Popout mode: only render the one session we were opened for.
        if (IS_POPOUT && m.id !== POPOUT_ID) continue;
        // Dormant sessions live in the resume picker, not the main tab bar.
        if (m.dormant) continue;
        ensureTab(m, IS_POPOUT);
      }
      if (tabs.size === 0 && activeId == null) renderEmpty();
      else restoreActiveFromLS();
      break;
    case 'session.created':
      // In popout windows, ignore creates for other sessions.
      if (IS_POPOUT && msg.session.id !== POPOUT_ID) break;
      // Treat session.created as "this session is now live (or resumed)" —
      // ensureTab is idempotent, and we want to attach even if a tab exists.
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
  // In popout mode we don't render the empty splash — popout is meant to be
  // a single session pane. If it never showed up, the user will see the
  // "session not found" terminal message instead.
  if (IS_POPOUT) return;
  panesEl.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.innerHTML = `
    <img class="empty-minion" src="/favicon.svg" alt="" />
    <div class="empty-title">No minions yet</div>
    <div class="empty-sub">Spawn a Copilot session on a branch of your choosing, or pick up where you left off.</div>
    <div class="empty-actions">
      <button id="empty-new">+ Spawn a new minion</button>
      <button id="empty-resume" class="secondary">↻ Resume a session</button>
    </div>
    <div style="font-size:11px; color: var(--fg-dim)">cwd: <code>${escapeHtml(getDefaultCwd())}</code></div>
  `;
  panesEl.appendChild(empty);
  empty.querySelector('#empty-new')?.addEventListener('click', () => openNewSessionModal());
  empty.querySelector('#empty-resume')?.addEventListener('click', () => openResumePicker());
}

/**
 * Human-readable label for a session. Default to "<repo>/<branch>", which is
 * what people care about; fall back through branch → short id. The session
 * UUID is the routing key, not a name to show users.
 */
function labelFor(meta: SessionMeta): string {
  // User-set custom title (via tab rename) wins over everything.
  const custom = getCustomTitle(meta.id);
  if (custom) return custom;
  const repo = meta.repoPath ? meta.repoPath.replace(/\/+$/, '').split('/').pop() : null;
  const branch = meta.branch;
  // If the server has a title that isn't just the branch, prefer it.
  if (meta.title && meta.title !== branch) return meta.title;
  if (repo && branch) return `${repo}/${branch}`;
  if (branch) return branch;
  if (repo) return repo;
  return meta.id.slice(0, 8);
}

function statusDescription(s: SessionStatus): string {
  switch (s) {
    case 'spawning': return 'spawning · waking up a new minion';
    case 'working': return 'working · agent is thinking / running tools';
    case 'needs-input': return 'needs input · agent is waiting for a y/n or approval';
    case 'idle': return 'idle · agent finished its turn, ready for the next message';
    case 'error': return 'error · last operation failed';
    case 'exited': return 'exited · process is done';
    default: return s;
  }
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
    // Per-repo accent color (border / underline). Deterministic by repoPath.
    tabEl.style.setProperty('--repo-color', colorForRepo(meta.repoPath ?? null));
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.title = statusDescription(meta.status);
    const label = document.createElement('span');
    label.textContent = labelFor(meta);
    label.className = 'label';
    label.title = labelFor(meta);
    // Double-click the label → rename inline. Saved to localStorage so the
    // custom title persists across reloads and across browser tabs.
    label.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      beginRename(meta.id);
    });
    const pop = document.createElement('span');
    pop.className = 'pop';
    pop.textContent = '↗';
    pop.title = 'Pop out into its own window';
    pop.addEventListener('click', (ev) => {
      ev.stopPropagation();
      popOutSession(meta.id);
    });
    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '×';
    close.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (confirm('close session?')) closeAndRemoveTab(meta.id);
    });
    tabEl.append(dot, label, pop, close);
    tabEl.addEventListener('click', () => activate(meta.id));
    // Right-click → context menu (rename / pop out / close).
    tabEl.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      showTabContextMenu(meta.id, ev.clientX, ev.clientY);
    });
    // Insert before the inline "+" button so it stays as the last child of .tabs
    // and visually floats just to the right of the last tab.
    const inlineNew = document.getElementById('inline-new');
    if (inlineNew && inlineNew.parentElement === tabsEl) {
      tabsEl.insertBefore(tabEl, inlineNew);
    } else {
      tabsEl.appendChild(tabEl);
    }

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

    // Loading overlay — shown while spawning, hidden on first PTY byte or
    // when status moves out of 'spawning'. Lives inside the term-wrap so it
    // covers exactly the terminal area.
    const loadingEl = document.createElement('div');
    loadingEl.className = 'loading-overlay';
    loadingEl.innerHTML = `
      <img src="/minion-loader.svg" alt="" />
      <div class="loading-text">spawning</div>
    `;
    if (meta.status !== 'spawning') loadingEl.dataset.hidden = '1';
    termWrap.appendChild(loadingEl);

    panesEl.appendChild(paneEl);

    const term = new Terminal({
      convertEol: false,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      theme: {
        // Tokyo Night-ish palette. Matches the rest of the UI chrome.
        background: '#15171c',
        foreground: '#c0caf5',
        cursor: '#7aa2f7',
        cursorAccent: '#15171c',
        selectionBackground: '#283457',
        black: '#15171c',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#a9b1d6',
        brightBlack: '#414868',
        brightRed: '#ff7a93',
        brightGreen: '#b9f27c',
        brightYellow: '#ff9e64',
        brightBlue: '#7da6ff',
        brightMagenta: '#bb9af7',
        brightCyan: '#0db9d7',
        brightWhite: '#c0caf5',
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

    t = { meta, term, fit, tabEl, paneEl, loadingEl, firstByteSeen: false };
    tabs.set(meta.id, t);

    // refit on container resize
    new ResizeObserver(() => {
      try { t!.fit.fit(); } catch { /* ignore */ }
    }).observe(termWrap);
  } else {
    // Tab already exists — update its meta so status/branch/etc reflect the
    // latest server-side state (covers resume: dormant → spawning).
    t.meta = meta;
    const labelNode = t.tabEl.querySelector('.label') as HTMLElement | null;
    if (labelNode) {
      labelNode.textContent = labelFor(meta);
      labelNode.title = labelFor(meta);
    }
    // Refresh the repo color in case repoPath was filled in after the tab was
    // initially created (e.g. dormant restore where repoPath shows up later).
    t.tabEl.style.setProperty('--repo-color', colorForRepo(meta.repoPath ?? null));
    if (meta.status === 'spawning') {
      delete t.loadingEl.dataset.hidden;
      t.firstByteSeen = false;
    }
  }

  // In popout mode, set the window title to the session label so multi-monitor
  // setups stay legible at the OS chrome level.
  if (IS_POPOUT && meta.id === POPOUT_ID) {
    document.title = `MinionHQ · ${labelFor(meta)}`;
    const ptitle = document.getElementById('popout-title');
    if (ptitle) ptitle.textContent = labelFor(meta);
  }

  // Subscribe to the session's PTY stream. Always send attach — the server
  // is idempotent (re-attaching cleans up any prior subscription). Sessions
  // can be created via WS (session.new), via the HTTP intent endpoint, OR
  // via resume of a dormant session (no prior browser subscription).
  sendMsg({ t: 'session.attach', id: meta.id });

  // Activate the new tab when requested OR when there's no active tab yet
  // (e.g. page just loaded with existing sessions, or a session was created
  // via the HTTP intent endpoint before any browser was connected).
  if (makeActive || activeId == null) activate(meta.id);
}

function activate(id: string) {
  if (activeId === id) return;
  activeId = id;
  // Persist so a page refresh stays on this tab instead of snapping back
  // to the first one. Popout windows never write this — they always show a
  // single specific session by URL.
  if (!IS_POPOUT) lsSet(LS_KEYS.activeId, id);
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

function restoreActiveFromLS() {
  // Called after session.list to land on the previously-active tab instead
  // of the first one in the iteration order. Quietly no-op if the saved id
  // is gone (session closed, etc.) or we're in popout mode.
  if (IS_POPOUT) return;
  const saved = lsGet(LS_KEYS.activeId);
  if (!saved || !tabs.has(saved)) return;
  if (activeId === saved) return;
  // activate() short-circuits if equal — force the reactivation path.
  activeId = null;
  activate(saved);
}

// ─────────────────────────── tab actions ─────────────────────────────

/**
 * Open a session in its own browser window via /?pop=<id>.
 * Marks the session as "popped out from this window" so the main window
 * stops firing chimes / OS notifications for that session — the popout
 * window handles them now and we don't want double-alerts.
 */
const poppedOutSessions = new Set<string>();

function popOutSession(id: string): void {
  poppedOutSessions.add(id);
  // Cancel any in-flight alert so we don't get a stale chime/notify right
  // after popping out — the popout window owns alerts for this session now.
  alertDispatcher.cancel(id);
  const url = `/?pop=${encodeURIComponent(id)}`;
  window.open(url, `minionhq-${id}`, 'width=920,height=720,resizable=yes');
}

/**
 * Kill the PTY for this session AND remove the tab from the UI. The session
 * stays dormant on the server (resumable from the resume drawer) — closing
 * just declutters the tab bar. If the closed tab was active, activate the
 * next-best neighbour, falling back to the empty state.
 */
function closeAndRemoveTab(id: string): void {
  // Tell the server first; the resulting pty.exit may race but the tab
  // will already be gone so the handler is a no-op.
  sendMsg({ t: 'session.close', id });
  removeTab(id);
}

function removeTab(id: string): void {
  const t = tabs.get(id);
  if (!t) return;
  alertDispatcher.cancel(id);
  try { t.term.dispose(); } catch { /* ignore */ }
  t.tabEl.remove();
  t.paneEl.remove();
  tabs.delete(id);

  if (activeId === id) {
    activeId = null;
    if (!IS_POPOUT) lsRemove(LS_KEYS.activeId);
    // Pick another tab if any remain — prefer the one that was visually
    // next to the closed one in DOM order. tabs Map iteration order matches
    // insertion order, which approximates DOM order well enough.
    const remaining = [...tabs.keys()];
    if (remaining.length > 0) {
      activate(remaining[0]);
    } else {
      renderEmpty();
    }
  }
}

function beginRename(id: string): void {
  const t = tabs.get(id);
  if (!t) return;
  const label = t.tabEl.querySelector('.label') as HTMLElement | null;
  if (!label) return;
  if (label.isContentEditable) return;
  const before = label.textContent ?? '';
  label.contentEditable = 'true';
  label.spellcheck = false;
  // Select all so the user can immediately type a replacement.
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(label);
  sel?.removeAllRanges();
  sel?.addRange(range);
  label.focus();

  const commit = (cancel = false) => {
    label.removeEventListener('keydown', onKey);
    label.removeEventListener('blur', onBlur);
    label.contentEditable = 'false';
    if (cancel) {
      label.textContent = before;
      return;
    }
    const next = (label.textContent ?? '').trim();
    if (!next || next === before) {
      label.textContent = labelFor(t.meta);
      label.title = labelFor(t.meta);
      return;
    }
    setCustomTitle(id, next);
    label.textContent = next;
    label.title = next;
    if (IS_POPOUT && id === POPOUT_ID) {
      document.title = `MinionHQ · ${next}`;
      const ptitle = document.getElementById('popout-title');
      if (ptitle) ptitle.textContent = next;
    }
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(false); label.blur(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); commit(true); label.blur(); }
  };
  const onBlur = () => commit(false);
  label.addEventListener('keydown', onKey);
  label.addEventListener('blur', onBlur);
}

function showTabContextMenu(id: string, x: number, y: number): void {
  // One menu at a time — tear down any existing one.
  document.querySelectorAll('.tab-menu').forEach((n) => n.remove());
  const t = tabs.get(id);
  if (!t) return;
  const menu = document.createElement('div');
  menu.className = 'tab-menu';
  menu.innerHTML = `
    <button data-act="rename">Rename…</button>
    <button data-act="popout">Pop out</button>
    <button data-act="reset-name">Reset name</button>
    <button data-act="close" class="danger">Close session</button>
  `;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);
  // Clamp into the viewport.
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth) menu.style.left = `${window.innerWidth - r.width - 6}px`;
  if (r.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - r.height - 6}px`;

  const close = () => {
    menu.remove();
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onDocKey, true);
  };
  const onDocDown = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) close();
  };
  const onDocKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') close(); };
  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onDocKey, true);

  menu.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null;
    if (!btn) return;
    const act = btn.dataset.act!;
    close();
    if (act === 'rename') beginRename(id);
    else if (act === 'popout') popOutSession(id);
    else if (act === 'reset-name') {
      setCustomTitle(id, null);
      const lbl = t.tabEl.querySelector('.label') as HTMLElement | null;
      if (lbl) { lbl.textContent = labelFor(t.meta); lbl.title = labelFor(t.meta); }
    }
    else if (act === 'close') {
      if (confirm('close session?')) closeAndRemoveTab(id);
    }
  });
}

function updateStatus(id: string, status: SessionStatus) {
  const t = tabs.get(id);
  if (!t) return;
  const prev = t.meta.status;
  t.meta.status = status;
  t.tabEl.dataset.status = status;
  const dot = t.tabEl.querySelector('.dot') as HTMLElement | null;
  if (dot) dot.title = statusDescription(status);

  // Hide the loading overlay once the session leaves 'spawning'.
  if (status !== 'spawning' && t.loadingEl.dataset.hidden !== '1') {
    t.loadingEl.dataset.hidden = '1';
  }

  if (prev === status) return;
  // Sessions popped out from this window get silenced here — the popout
  // owns chimes/notifications for that session to avoid double-alerting.
  if (poppedOutSessions.has(id)) return;

  // Hand the transition to the dispatcher. It will coalesce rapid bursts
  // (e.g. working → idle → needs-input within 150ms) into ONE alert of the
  // highest-priority kind, and will NOT fire on spawning → idle.
  alertDispatcher.onTransition(id, prev, status);
}

// Singleton alert dispatcher. The `fire` callback is the ONLY place chimes
// and OS notifications are triggered for status events — keeping that funnel
// narrow ensures we can never accidentally fire two chimes for one event.
const alertDispatcher = new AlertDispatcher({
  windowMs: 500,
  fire(id, kind) {
    const t = tabs.get(id);
    if (!t) return;
    if (poppedOutSessions.has(id)) return;
    if (chimesEnabled) playChime(kind);
    if (notifyEnabled) notify(kind, labelFor(t.meta));
  },
});

function newSession(opts?: { cwd?: string; repoPath?: string; branchName?: string }) {
  sendMsg({ t: 'session.new', ...opts });
}

// ─────────────────────────── new-session modal ─────────────────────────────

function openNewSessionModal(): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const lastRepo = lsGet(LS_KEYS.lastRepo) ?? '';
  const lastBase = lsGet(LS_KEYS.lastReposBase) ?? '';
  overlay.innerHTML = `
    <div class="modal">
      <h2>new minion session</h2>
      <label>
        <span>repo <em>(from <code id="cm-base-dir">~/repositories</code> · <a href="#" id="cm-change-base">change</a>)</em></span>
        <select id="cm-repo-select" autofocus>
          <option value="">(loading…)</option>
        </select>
        <span class="repo-status" id="cm-repo-status"></span>
      </label>
      <label>
        <span>branch off from <em>(base branch)</em></span>
        <select id="cm-base" disabled>
          <option value="">(pick a repo first)</option>
        </select>
      </label>
      <label>
        <span>new branch name <em>(blank = auto <code>feat/&lt;id&gt;</code>)</em></span>
        <input id="cm-branch" type="text" placeholder="feat/my-feature" />
      </label>
      <p class="hint">tip: from your regular Copilot CLI, ask it to spawn a MinionHQ session in natural language — it'll call <code>POST /api/intent/create-session</code> and a tab will appear here automatically. see <code>docs/MINIONHQ-COPILOT-INSTRUCTIONS.md</code>.</p>
      <p class="hint">a fresh git worktree on the new branch is created under <code>~/.minionhq/wt/&lt;id&gt;/</code>. your main checkout is never touched. uncommitted work is auto-committed on exit — branches always persist.</p>
      <div class="modal-actions">
        <button class="ghost" id="cm-cancel">cancel</button>
        <button class="primary" id="cm-ok">spawn</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  unlockAudio();
  ensurePermission();

  const repoSelect  = overlay.querySelector('#cm-repo-select') as HTMLSelectElement;
  const baseSelect  = overlay.querySelector('#cm-base') as HTMLSelectElement;
  const branchInput = overlay.querySelector('#cm-branch') as HTMLInputElement;
  const repoStatus  = overlay.querySelector('#cm-repo-status') as HTMLSpanElement;
  const baseDirEl   = overlay.querySelector('#cm-base-dir') as HTMLElement;
  const changeBase  = overlay.querySelector('#cm-change-base') as HTMLAnchorElement;

  let currentBase = lastBase || '~/repositories';
  baseDirEl.textContent = currentBase;

  async function discoverAndFill(base: string): Promise<void> {
    repoSelect.innerHTML = '<option value="">(loading…)</option>';
    repoSelect.disabled = true;
    try {
      const r = await fetch(`/api/repos/discover?base=${encodeURIComponent(base)}`);
      const data = await r.json() as {
        ok: boolean;
        base?: string;
        repos?: Array<{ name: string; path: string; defaultBranch: string | null }>;
        error?: string;
      };
      if (!data.ok) {
        repoSelect.innerHTML = `<option value="">(error: ${escapeHtml(data.error ?? 'unknown')})</option>`;
        return;
      }
      currentBase = data.base ?? base;
      baseDirEl.textContent = currentBase;
      lsSet(LS_KEYS.lastReposBase, currentBase);
      const repos = data.repos ?? [];
      if (repos.length === 0) {
        repoSelect.innerHTML = `<option value="">(no git repos found in ${escapeHtml(currentBase)})</option>`;
        return;
      }
      const opts = ['<option value="">(choose a repo)</option>'];
      for (const repo of repos) {
        const selected = repo.path === lastRepo ? ' selected' : '';
        opts.push(`<option value="${escapeHtml(repo.path)}"${selected}>${escapeHtml(repo.name)}${repo.defaultBranch ? '  ·  ' + escapeHtml(repo.defaultBranch) : ''}</option>`);
      }
      repoSelect.innerHTML = opts.join('');
      repoSelect.disabled = false;
      if (repoSelect.value) void refreshBranches(repoSelect.value);
    } catch (e) {
      repoSelect.innerHTML = `<option value="">(${escapeHtml((e as Error).message)})</option>`;
    }
  }

  let lastFetchToken = 0;
  async function refreshBranches(path: string): Promise<void> {
    const token = ++lastFetchToken;
    if (!path.trim()) {
      baseSelect.innerHTML = '<option value="">(pick a repo first)</option>';
      baseSelect.disabled = true;
      repoStatus.textContent = '';
      return;
    }
    repoStatus.textContent = 'checking…';
    repoStatus.className = 'repo-status checking';
    try {
      const r = await fetch(`/api/repo/branches?path=${encodeURIComponent(path)}`);
      if (token !== lastFetchToken) return;
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
      repoStatus.textContent = `✓ ${data.repoPath} — ${branches.length} branch${branches.length === 1 ? '' : 'es'}`;
      repoStatus.className = 'repo-status ok';
    } catch (e) {
      if (token !== lastFetchToken) return;
      repoStatus.textContent = 'check failed: ' + (e as Error).message;
      repoStatus.className = 'repo-status warn';
    }
  }

  repoSelect.addEventListener('change', () => {
    void refreshBranches(repoSelect.value);
    branchInput.focus();
  });

  changeBase.addEventListener('click', (ev) => {
    ev.preventDefault();
    const next = prompt('repo discovery base directory (e.g. ~/repositories):', currentBase);
    if (next && next.trim()) void discoverAndFill(next.trim());
  });

  void discoverAndFill(currentBase);

  const cleanup = () => overlay.remove();
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) cleanup(); });
  overlay.querySelector('#cm-cancel')!.addEventListener('click', cleanup);

  const submit = () => {
    const repo = repoSelect.value.trim();
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
    const target = ev.target as HTMLElement;
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      submit();
    } else if (ev.key === 'Enter' && target.tagName !== 'SELECT' && target.tagName !== 'TEXTAREA') {
      ev.preventDefault();
      submit();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      cleanup();
    }
  });
  repoSelect.focus();
}

newBtn.addEventListener('click', () => { unlockAudio(); openNewSessionModal(); });

const inlineNewBtn = document.getElementById('inline-new') as HTMLButtonElement | null;
inlineNewBtn?.addEventListener('click', () => { unlockAudio(); openNewSessionModal(); });

const resumeBtn = document.getElementById('resume-session') as HTMLButtonElement | null;
resumeBtn?.addEventListener('click', () => { unlockAudio(); openResumePicker(); });

async function openResumePicker(): Promise<void> {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>resume a session</h2>
      <div id="cm-resume-list" class="resume-list">loading…</div>
      <p class="hint">click a session to resume it. copilot is restarted in the existing worktree with <code>--resume</code>, so the conversation history continues.</p>
      <div class="modal-actions">
        <button class="ghost" id="cm-resume-cancel">close</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const listEl   = overlay.querySelector('#cm-resume-list') as HTMLDivElement;
  const cancelBtn = overlay.querySelector('#cm-resume-cancel') as HTMLButtonElement;

  function cleanup() { overlay.remove(); }
  cancelBtn.addEventListener('click', cleanup);
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) cleanup(); });
  document.addEventListener('keydown', function esc(ev) {
    if (ev.key === 'Escape') { cleanup(); document.removeEventListener('keydown', esc); }
  });

  try {
    const r = await fetch('/api/sessions/dormant');
    const data = await r.json() as { ok: boolean; sessions?: SessionMeta[]; error?: string };
    if (!data.ok || !data.sessions) {
      listEl.textContent = `error: ${data.error ?? 'unknown'}`;
      return;
    }
    if (data.sessions.length === 0) {
      listEl.innerHTML = '<div class="resume-empty">no dormant sessions. when copilot processes exit, their worktrees remain on disk and they appear here as resumable.</div>';
      return;
    }
    // Group by repo name (last path segment of repoPath).
    const groups = new Map<string, SessionMeta[]>();
    for (const s of data.sessions) {
      const repo = s.repoPath ? s.repoPath.split('/').pop() ?? s.repoPath : '(no repo)';
      if (!groups.has(repo)) groups.set(repo, []);
      groups.get(repo)!.push(s);
    }
    listEl.innerHTML = '';
    for (const [repo, sessions] of groups) {
      const groupEl = document.createElement('div');
      groupEl.className = 'resume-group';
      const heading = document.createElement('div');
      heading.className = 'resume-repo';
      heading.textContent = repo;
      groupEl.appendChild(heading);
      for (const s of sessions) {
        const row = document.createElement('button');
        row.className = 'resume-row';
        row.type = 'button';
        const when = new Date(s.updatedAt).toLocaleString();
        row.innerHTML = `
          <div class="resume-row-main">
            <span class="resume-branch">${escapeHtml(s.branch ?? '(no branch)')}</span>
            <span class="resume-when">${escapeHtml(when)}</span>
          </div>
          <div class="resume-row-sub">${escapeHtml(s.id.slice(0, 8))} · ${s.copilotSessionId ? 'copilot session ' + escapeHtml(s.copilotSessionId.slice(0, 8)) : 'no copilot id (will use --continue)'}</div>
        `;
        row.addEventListener('click', () => {
          sendMsg({ t: 'session.resume', id: s.id });
          cleanup();
        });
        groupEl.appendChild(row);
      }
      listEl.appendChild(groupEl);
    }
  } catch (e) {
    listEl.textContent = `error: ${(e as Error).message}`;
  }
}

// Global keyboard shortcuts.
//
// We deliberately avoid plain ⌘T / ⌘W / ⌘1..9 because Edge, Chrome, and Safari
// all intercept those before our keydown listener runs — preventDefault is too
// late. Instead we use Ctrl+Alt+<key> (⌃⌥ on macOS, Ctrl+Alt on Windows/Linux),
// which the browser doesn't grab for any built-in action.
document.addEventListener('keydown', (ev) => {
  if (!(ev.ctrlKey && ev.altKey)) return;
  const k = ev.key.toLowerCase();
  if (k === 't') {
    ev.preventDefault();
    openNewSessionModal();
  } else if (k === 'w') {
    if (activeId) {
      ev.preventDefault();
      if (confirm('close session?')) closeAndRemoveTab(activeId);
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
    if (chimesEnabled) playChime('agent-finished');
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

// ─────────────────────────── context drawer ────────────────────────────────
const ctxDrawer = document.getElementById('context-drawer') as HTMLElement | null;
const ctxOpenBtn = document.getElementById('open-context') as HTMLButtonElement | null;
const ctxCloseBtn = document.getElementById('close-context') as HTMLButtonElement | null;
const ctxMeta = document.getElementById('ctx-meta') as HTMLElement | null;
const ctxList = document.getElementById('ctx-list') as HTMLElement | null;
const ctxFilename = document.getElementById('ctx-filename') as HTMLInputElement | null;
const ctxContent = document.getElementById('ctx-content') as HTMLTextAreaElement | null;
const ctxSaveBtn = document.getElementById('ctx-save') as HTMLButtonElement | null;
const ctxNewBtn = document.getElementById('ctx-new') as HTMLButtonElement | null;
const ctxDeleteBtn = document.getElementById('ctx-delete') as HTMLButtonElement | null;
const ctxStatus = document.getElementById('ctx-status') as HTMLElement | null;

interface CtxFile { name: string; size: number; modified: number; }
let ctxCurrentRepo: string | null = null;
let ctxCurrentFile: string | null = null;
let ctxFiles: CtxFile[] = [];

function activeRepoPath(): string | null {
  if (activeId) {
    const t = tabs.get(activeId);
    if (t?.meta.repoPath) return t.meta.repoPath;
  }
  return lsGet(LS_KEYS.lastRepo);
}

function setCtxStatus(text: string, cls: 'ok' | 'err' | '' = ''): void {
  if (!ctxStatus) return;
  ctxStatus.textContent = text;
  ctxStatus.className = 'ctx-status' + (cls ? ' ' + cls : '');
  if (text && cls === 'ok') {
    window.setTimeout(() => {
      if (ctxStatus && ctxStatus.textContent === text) ctxStatus.textContent = '';
    }, 1800);
  }
}

async function refreshCtxList(): Promise<void> {
  const repo = activeRepoPath();
  if (!repo) {
    if (ctxMeta) ctxMeta.textContent = 'No active repo. Open a session first.';
    if (ctxList) ctxList.innerHTML = '<div class="ctx-empty">No repo selected. Open a session to view its central context.</div>';
    ctxFiles = [];
    return;
  }
  await loadCtxList(repo);
}

function refitActiveTerminal(): void {
  if (!activeId) return;
  const t = tabs.get(activeId);
  if (!t) return;
  try { t.fit.fit(); } catch { /* ignore */ }
}

/**
 * Trigger several fit calls across the drawer's CSS transition window so the
 * active terminal lands at the right size at every stage:
 *   - immediately (catch the layout change)
 *   - mid-transition (rAF + 50ms)
 *   - post-transition (220ms after the 180ms CSS transition completes)
 *   - belt-and-suspenders (400ms, in case anything else is in flight)
 */
function refitAfterDrawerToggle(): void {
  refitActiveTerminal();
  requestAnimationFrame(() => { refitActiveTerminal(); });
  setTimeout(refitActiveTerminal, 50);
  setTimeout(refitActiveTerminal, 220);
  setTimeout(refitActiveTerminal, 400);
}

async function openCtxDrawer(): Promise<void> {
  if (!ctxDrawer) return;
  ctxDrawer.setAttribute('aria-hidden', 'false');
  document.body.classList.add('drawer-open');
  refitAfterDrawerToggle();
  await refreshCtxList();
}

function closeCtxDrawer(): void {
  if (!ctxDrawer) return;
  ctxDrawer.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('drawer-open');
  refitAfterDrawerToggle();
}

async function loadCtxList(repo: string): Promise<void> {
  if (!ctxList || !ctxMeta) return;
  ctxCurrentRepo = repo;
  ctxMeta.textContent = `Loading ${repo}…`;
  try {
    const res = await fetch(`/api/repo/context/list?path=${encodeURIComponent(repo)}`);
    const data = await res.json() as { ok: boolean; key?: string; centralDir?: string; files?: CtxFile[]; error?: string };
    if (!data.ok) {
      ctxMeta.textContent = `⚠ ${data.error}`;
      ctxList.innerHTML = '';
      return;
    }
    ctxMeta.innerHTML = `<div><strong>repo:</strong> ${escapeHtml(repo)}</div><div><strong>central:</strong> ${escapeHtml(data.centralDir ?? '')}</div><div class="ctx-hint">Shared across every session on this repo (any branch). Sessions also auto-write transcripts here.</div>`;
    ctxFiles = data.files ?? [];
    renderCtxList();
  } catch (e) {
    ctxMeta.textContent = `⚠ ${(e as Error).message}`;
  }
}

function renderCtxList(): void {
  if (!ctxList) return;
  if (ctxFiles.length === 0) {
    ctxList.innerHTML = '<div class="ctx-empty">No context files yet. Click "New file" to add one.</div>';
    return;
  }
  ctxList.innerHTML = '';
  for (const f of ctxFiles) {
    const item = document.createElement('div');
    item.className = 'ctx-item' + (f.name === ctxCurrentFile ? ' active' : '');
    item.innerHTML = `<span>${escapeHtml(f.name)}</span><span class="size">${f.size}b</span>`;
    item.addEventListener('click', () => { void loadCtxFile(f.name); });
    ctxList.appendChild(item);
  }
}

async function loadCtxFile(name: string): Promise<void> {
  if (!ctxFilename || !ctxContent || !ctxCurrentRepo) return;
  try {
    const res = await fetch(`/api/repo/context/read?path=${encodeURIComponent(ctxCurrentRepo)}&name=${encodeURIComponent(name)}`);
    const data = await res.json() as { ok: boolean; content?: string; error?: string };
    if (!data.ok) { setCtxStatus(data.error ?? 'read failed', 'err'); return; }
    ctxCurrentFile = name;
    ctxFilename.value = name;
    ctxContent.value = data.content ?? '';
    renderCtxList();
    setCtxStatus('');
  } catch (e) {
    setCtxStatus((e as Error).message, 'err');
  }
}

async function saveCtxFile(): Promise<void> {
  if (!ctxFilename || !ctxContent) return;
  const name = ctxFilename.value.trim();
  if (!name) { setCtxStatus('filename required', 'err'); return; }
  if (!/\.md$/i.test(name)) { setCtxStatus('must end in .md', 'err'); return; }
  if (!ctxCurrentRepo) { setCtxStatus('no repo selected', 'err'); return; }
  setCtxStatus('saving…');
  try {
    const res = await fetch('/api/repo/context/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: ctxCurrentRepo, name, content: ctxContent.value }),
    });
    const data = await res.json() as { ok: boolean; error?: string };
    if (!data.ok) { setCtxStatus(data.error ?? 'save failed', 'err'); return; }
    setCtxStatus('saved ✓', 'ok');
    ctxCurrentFile = name;
    await refreshCtxList();
  } catch (e) {
    setCtxStatus((e as Error).message, 'err');
  }
}

async function deleteCtxFile(): Promise<void> {
  if (!ctxCurrentFile || !ctxCurrentRepo) return;
  if (!confirm(`Delete ${ctxCurrentFile}? This affects every session on this repo.`)) return;
  try {
    const res = await fetch('/api/repo/context/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: ctxCurrentRepo, name: ctxCurrentFile }),
    });
    const data = await res.json() as { ok: boolean; error?: string };
    if (!data.ok) { setCtxStatus(data.error ?? 'delete failed', 'err'); return; }
    if (ctxFilename) ctxFilename.value = '';
    if (ctxContent) ctxContent.value = '';
    ctxCurrentFile = null;
    setCtxStatus('deleted', 'ok');
    await refreshCtxList();
  } catch (e) {
    setCtxStatus((e as Error).message, 'err');
  }
}

function newCtxFile(): void {
  if (!ctxFilename || !ctxContent) return;
  ctxCurrentFile = null;
  ctxFilename.value = '';
  ctxContent.value = '';
  ctxFilename.focus();
  renderCtxList();
}

// Click the "context" topbar button to TOGGLE the drawer (open if closed,
// close if currently open). This way the same button users used to open it
// also dismisses it without having to aim for the ✕.
ctxOpenBtn?.addEventListener('click', () => {
  if (ctxDrawer?.getAttribute('aria-hidden') === 'false') closeCtxDrawer();
  else void openCtxDrawer();
});
ctxCloseBtn?.addEventListener('click', closeCtxDrawer);
ctxSaveBtn?.addEventListener('click', () => { void saveCtxFile(); });
ctxNewBtn?.addEventListener('click', newCtxFile);
ctxDeleteBtn?.addEventListener('click', () => { void deleteCtxFile(); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ctxDrawer?.getAttribute('aria-hidden') === 'false') {
    closeCtxDrawer();
    e.preventDefault();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === '.') {
    if (ctxDrawer?.getAttribute('aria-hidden') === 'false') closeCtxDrawer();
    else void openCtxDrawer();
    e.preventDefault();
  }
});

connect();
renderEmpty();
