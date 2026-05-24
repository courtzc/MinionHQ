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
  lastReposBase: 'cm.lastReposBase',
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

    // Subscribe to the session's PTY stream. Always send attach — the server
    // is idempotent (re-attaching cleans up any prior subscription). Sessions
    // can be created via WS (session.new) OR via the HTTP intent endpoint, so
    // we can't assume the server has already attached us.
    sendMsg({ t: 'session.attach', id: meta.id });

    // refit on container resize
    new ResizeObserver(() => {
      try { t!.fit.fit(); } catch { /* ignore */ }
    }).observe(termWrap);
  }
  // Activate the new tab when requested OR when there's no active tab yet
  // (e.g. page just loaded with existing sessions, or a session was created
  // via the HTTP intent endpoint before any browser was connected).
  if (makeActive || activeId == null) activate(meta.id);
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
  const lastBase = lsGet(LS_KEYS.lastReposBase) ?? '';
  overlay.innerHTML = `
    <div class="modal">
      <h2>new copilot session</h2>
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
      <p class="hint">tip: from your regular Copilot CLI, ask it to spawn an HQ session in natural language — it'll call <code>POST /api/intent/create-session</code> and a tab will appear here automatically. see <code>docs/HQ-COPILOT-INSTRUCTIONS.md</code>.</p>
      <p class="hint">a fresh git worktree on the new branch is created under <code>~/.copilot-multi/wt/&lt;id&gt;/</code>. your main checkout is never touched. uncommitted work is auto-committed on exit — branches always persist.</p>
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

async function openCtxDrawer(): Promise<void> {
  if (!ctxDrawer) return;
  ctxDrawer.setAttribute('aria-hidden', 'false');
  const repo = activeRepoPath();
  if (!repo) {
    if (ctxMeta) ctxMeta.textContent = 'No active repo. Open a session first, or set a repo via "+ new".';
    if (ctxList) ctxList.innerHTML = '<div class="ctx-empty">No repo selected.</div>';
    return;
  }
  await loadCtxList(repo);
}

function closeCtxDrawer(): void {
  if (!ctxDrawer) return;
  ctxDrawer.setAttribute('aria-hidden', 'true');
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
    ctxMeta.innerHTML = `<div><strong>repo:</strong> ${repo}</div><div><strong>central:</strong> ${data.centralDir}</div>`;
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
    item.innerHTML = `<span>${f.name}</span><span class="size">${f.size}b</span>`;
    item.addEventListener('click', () => { void loadCtxFile(f.name); });
    ctxList.appendChild(item);
  }
}

async function loadCtxFile(name: string): Promise<void> {
  if (!ctxCurrentRepo || !ctxFilename || !ctxContent) return;
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
  if (!ctxCurrentRepo || !ctxFilename || !ctxContent) return;
  const name = ctxFilename.value.trim();
  if (!name) { setCtxStatus('filename required', 'err'); return; }
  if (!/\.md$/i.test(name)) { setCtxStatus('must end in .md', 'err'); return; }
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
    await loadCtxList(ctxCurrentRepo);
  } catch (e) {
    setCtxStatus((e as Error).message, 'err');
  }
}

async function deleteCtxFile(): Promise<void> {
  if (!ctxCurrentRepo || !ctxCurrentFile) return;
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
    await loadCtxList(ctxCurrentRepo);
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

ctxOpenBtn?.addEventListener('click', () => { void openCtxDrawer(); });
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
