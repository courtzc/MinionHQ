import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, openSync, readSync, closeSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve, extname, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import * as esbuild from 'esbuild';

import { sessionManager } from './sessions.js';
import { db, closeDb } from './db.js';
import { ensureDirs, DEFAULTS, sessionLogDir } from './paths.js';
import { closeAllLogs } from './logs.js';
import { isGitRepo, repoToplevel, listBranches, currentBranch, discoverRepos } from './worktrees.js';
import { readJsonBody, jsonOk, jsonErr, jsonBodyErr } from './httpUtil.js';
import { LIMITS } from './limits.js';
import { notifyMac, isMacNotifySupported, type MacNotifyKind } from './macNotify.js';
import {
  ensureRepoContext,
  listRepoContextFiles,
  readRepoContextFile,
  writeRepoContextFile,
  deleteRepoContextFile,
} from './context.js';
import {
  BIN_PTY_DATA,
  BIN_PTY_INPUT,
  BIN_HEADER_SIZE,
  uuidToBytes,
  bytesToUuid,
} from '../shared/binProtocol.js';
import {
  PROTOCOL_VERSION,
  type ClientMsg,
  type ServerMsg,
  type SessionStatus,
  type InputCause,
} from '../shared/protocol.js';

ensureDirs();
db(); // initialise + migrate

// Rehydrate dormant sessions whose worktrees survived the previous server's
// death. They'll show up in the resume picker and via smart-reuse in spawn().
const restored = sessionManager.restoreDormant();
if (restored.restored > 0 || restored.skipped > 0) {
  console.log(`[minionhq] restored ${restored.restored} dormant session(s), skipped ${restored.skipped}`);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const PUBLIC_DIR = join(PROJECT_ROOT, 'public');
const WEB_SRC_DIR = join(PROJECT_ROOT, 'src', 'web');
const SHARED_DIR = join(PROJECT_ROOT, 'src', 'shared');
const NODE_MODULES = join(PROJECT_ROOT, 'node_modules');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.map': 'application/json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function send(ws: WebSocket, msg: ServerMsg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function sendPtyDataBinary(ws: WebSocket, sessionId: string, payload: Buffer) {
  if (ws.readyState !== ws.OPEN) return;
  const frame = Buffer.allocUnsafe(BIN_HEADER_SIZE + payload.length);
  frame[0] = BIN_PTY_DATA;
  uuidToBytes(sessionId, frame, 1);
  payload.copy(frame, BIN_HEADER_SIZE);
  ws.send(frame, { binary: true });
}

const wsAttachments = new WeakMap<WebSocket, Map<string, () => void>>();
const attachedSockets = new Map<string, Set<WebSocket>>();
const allSockets = new Set<WebSocket>();

function broadcast(msg: ServerMsg) {
  for (const ws of allSockets) send(ws, msg);
}

function tryServeFile(absPath: string) {
  if (!existsSync(absPath)) return null;
  const s = statSync(absPath);
  if (!s.isFile()) return null;
  return {
    body: readFileSync(absPath),
    contentType: MIME[extname(absPath)] ?? 'application/octet-stream',
  };
}

function serveStatic(pathname: string) {
  // Try built /public first, then src/web for dev, then xterm.css from node_modules
  const wantsIndex = pathname === '/' || pathname === '';
  const rel = wantsIndex ? 'index.html' : pathname.replace(/^\//, '');

  for (const base of [PUBLIC_DIR, WEB_SRC_DIR]) {
    const candidate = join(base, rel);
    if (candidate.startsWith(base)) {
      const found = tryServeFile(candidate);
      if (found) return found;
    }
  }
  // xterm css fallback
  if (pathname === '/vendor/xterm.css') {
    const xtermCss = join(NODE_MODULES, '@xterm', 'xterm', 'css', 'xterm.css');
    return tryServeFile(xtermCss);
  }
  return null;
}

function* walkFiles(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p);
    else yield p;
  }
}

let bundleCache: { mtime: number; code: string } | null = null;
async function bundleApp(): Promise<string> {
  const entry = join(WEB_SRC_DIR, 'app.ts');
  if (!existsSync(entry)) return '// app.ts missing';
  let newest = 0;
  for (const dir of [WEB_SRC_DIR, SHARED_DIR]) {
    for (const f of walkFiles(dir)) {
      const m = statSync(f).mtimeMs;
      if (m > newest) newest = m;
    }
  }
  if (bundleCache && bundleCache.mtime === newest) return bundleCache.code;
  try {
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      target: 'es2022',
      platform: 'browser',
      sourcemap: 'inline',
      write: false,
      logLevel: 'silent',
      absWorkingDir: PROJECT_ROOT,
    });
    const code = result.outputFiles[0]?.text ?? '// no output';
    bundleCache = { mtime: newest, code };
    return code;
  } catch (e) {
    const msg = (e as Error).message.replace(/`/g, '');
    return `document.body.innerText = \`build error: ${msg}\`;`;
  }
}

// ─── AIFF → WAV transcoder cache ─────────────────────────────────────────────
// Chromium-based browsers (Chrome, Edge) can't decode AIFF or CAF. We use
// macOS's bundled `afconvert` to transcode on first request, then cache the
// WAV in tmpdir keyed by source path + mtime. Cache survives within the
// process lifetime; on restart we re-transcode (small files, fast).
const WAV_CACHE_DIR = join(tmpdir(), 'minionhq-wav-cache');
// Bump this when the transcoder logic changes so old cache entries are
// transparently invalidated (e.g. v1 → v2 added FLLR-chunk stripping).
const WAV_CACHE_VERSION = 'v2';
const wavCache = new Map<string, string>(); // src abs path → cached wav path

const VALID_NOTIFY_KINDS = new Set<string>([
  'needs-input', 'agent-finished', 'error',
  'ask-user', 'permission', 'elicitation',
  'session-spawned', 'session-resumed', 'session-stopped',
  'tool-failed',
]);
function transcodeToWav(srcAbsPath: string): string | null {
  try {
    const st = statSync(srcAbsPath);
    const key = `${srcAbsPath}::${st.mtimeMs}::${st.size}::${WAV_CACHE_VERSION}`;
    const cached = wavCache.get(key);
    if (cached && existsSync(cached)) return cached;
    if (!existsSync(WAV_CACHE_DIR)) mkdirSync(WAV_CACHE_DIR, { recursive: true });
    // Filename: sanitised base + content hash-ish suffix so collisions are unlikely.
    const safe = srcAbsPath.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
    const out = join(WAV_CACHE_DIR, `${safe}.${st.mtimeMs}.${WAV_CACHE_VERSION}.wav`);
    if (!existsSync(out)) {
      // afconvert: -f WAVE (container), -d LEI16 (16-bit little-endian PCM, the
      // safest WAV subformat for browser Web Audio decoders).
      const raw = `${out}.raw`;
      execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16', srcAbsPath, raw], {
        stdio: 'ignore',
      });
      // afconvert pads between `fmt ` and `data` with a `FLLR` filler chunk.
      // Chromium's decodeAudioData rejects WAVs that contain FLLR (even
      // though it's a valid skippable RIFF chunk). Rewrite the file with
      // FLLR (and any other non-essential chunks) stripped.
      const stripped = stripFillerChunks(readFileSync(raw));
      writeFileSync(out, stripped);
      try { unlinkSync(raw); } catch { /* best-effort */ }
    }
    wavCache.set(key, out);
    return out;
  } catch (e) {
    console.warn('[system-sound] transcode failed:', srcAbsPath, (e as Error).message);
    return null;
  }
}

// Strip RIFF padding/filler chunks (FLLR, JUNK, PAD ) from a WAV buffer.
// Keeps the chunks browsers actually need (fmt , data, fact) plus any
// chunk we don't explicitly drop. Chromium's decodeAudioData specifically
// rejects FLLR; this is the minimum-surgery fix.
function stripFillerChunks(buf: Buffer): Buffer {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return buf;
  }
  const drop = new Set(['FLLR', 'JUNK', 'PAD ']);
  const kept: Buffer[] = [];
  let i = 12;
  while (i + 8 <= buf.length) {
    const id = buf.toString('ascii', i, i + 4);
    const sz = buf.readUInt32LE(i + 4);
    const total = 8 + sz + (sz & 1); // chunks are word-aligned
    if (i + total > buf.length) break;
    if (!drop.has(id)) kept.push(buf.subarray(i, i + total));
    i += total;
  }
  const body = Buffer.concat(kept);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WAVE', 8, 'ascii');
  return Buffer.concat([header, body]);
}

const httpServer = createServer(async (req, res) => {
  if (!req.url) { res.statusCode = 400; return res.end('Bad request'); }
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/api/health') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION }));
  }
  if (url.pathname === '/api/repos/discover') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const base = url.searchParams.get('base') ?? '';
    try {
      const out = discoverRepos(base || undefined);
      return res.end(JSON.stringify({ ok: true, ...out }));
    } catch (e) {
      return res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
    }
  }

  // ─── Intent endpoint: external NL agents call this to spawn a session ─
  // POST { repo, branch?, base?, prompt? }
  //   repo   — repo name (resolved against discoverRepos) or absolute path
  //   branch — new branch name (default: feat/<id>)
  //   base   — base branch to fork off (default: repo's current branch)
  //   prompt — optional initial prompt to type once Copilot is ready
  // Returns { ok, id, branch, worktreePath, repoPath }.
  if (url.pathname === '/api/intent/create-session' && req.method === 'POST') {
    (async () => {
      try {
        const body = await readJsonBody<{
          repo?: string; branch?: string; base?: string; prompt?: string;
        }>(req);
        if (!body.repo || !body.repo.trim()) {
          return jsonErr(res, 400, 'missing repo');
        }

        let repoPath = body.repo.trim();
        if (!repoPath.startsWith('/') && !repoPath.startsWith('~')) {
          const { repos } = discoverRepos();
          const hit = repos.find((r) => r.name === repoPath)
                   ?? repos.find((r) => r.name.toLowerCase() === repoPath.toLowerCase());
          if (!hit) {
            return jsonErr(res, 404,
              `repo not found: ${repoPath}. Known: ${repos.map((r) => r.name).join(', ')}`);
          }
          repoPath = hit.path;
        }

        const meta = sessionManager.spawn({
          cwd: repoPath,
          repoPath,
          branchName: body.branch?.trim() || undefined,
          baseBranch: body.base?.trim() || undefined,
        });
        broadcast({ t: 'session.created', session: meta });

        if (body.prompt && body.prompt.trim()) {
          // Wait briefly for Copilot to render its prompt before injecting.
          // Use \r (TUI Enter) so the prompt auto-submits instead of
          // sitting as a literal newline in Copilot's input box.
          const text = body.prompt.trim() + '\r';
          setTimeout(() => {
            try { sessionManager.input(meta.id, Buffer.from(text, 'utf8')); } catch { /* ignore */ }
          }, 2500);
        }

        return jsonOk(res, {
          id: meta.id,
          branch: meta.branch,
          worktreePath: meta.worktreePath,
          repoPath: meta.repoPath,
          openInBrowser: `http://${req.headers.host ?? '127.0.0.1:4242'}/#${meta.id}`,
        });
      } catch (e) {
        return jsonBodyErr(res, e);
      }
    })();
    return;
  }
  if (url.pathname === '/api/repo/branches') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const p = url.searchParams.get('path') ?? '';
    if (!p) return res.end(JSON.stringify({ ok: false, error: 'missing path' }));
    if (!isGitRepo(p)) return res.end(JSON.stringify({ ok: false, error: 'not a git repo' }));
    try {
      const top = repoToplevel(p);
      const branches = listBranches(top);
      const current = currentBranch(top);
      return res.end(JSON.stringify({ ok: true, repoPath: top, branches, current }));
    } catch (e) {
      return res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
    }
  }

  // ─── Repo central-context API ───────────────────────────────────────────
  if (url.pathname === '/api/repo/context/list') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const p = url.searchParams.get('path') ?? '';
    if (!p) return res.end(JSON.stringify({ ok: false, error: 'missing path' }));
    try {
      const info = ensureRepoContext(p);
      const files = listRepoContextFiles(p);
      return res.end(JSON.stringify({ ok: true, key: info.key, centralDir: info.centralDir, files }));
    } catch (e) {
      return res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
    }
  }
  if (url.pathname === '/api/repo/context/read') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const p = url.searchParams.get('path') ?? '';
    const name = url.searchParams.get('name') ?? '';
    if (!p || !name) return res.end(JSON.stringify({ ok: false, error: 'missing path or name' }));
    try {
      const content = readRepoContextFile(p, name);
      return res.end(JSON.stringify({ ok: true, name, content }));
    } catch (e) {
      return res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
    }
  }
  if (url.pathname === '/api/repo/context/write' && req.method === 'POST') {
    (async () => {
      try {
        // Context files are markdown — bump the cap to 256KB to allow longer docs.
        const body = await readJsonBody<{ path?: string; name?: string; content?: string }>(
          req, 256 * 1024,
        );
        if (!body.path || !body.name || body.content == null) {
          return jsonErr(res, 400, 'missing path/name/content');
        }
        writeRepoContextFile(body.path, body.name, body.content);
        return jsonOk(res);
      } catch (e) {
        return jsonBodyErr(res, e);
      }
    })();
    return;
  }
  if (url.pathname === '/api/repo/context/delete' && req.method === 'POST') {
    (async () => {
      try {
        const body = await readJsonBody<{ path?: string; name?: string }>(req);
        if (!body.path || !body.name) return jsonErr(res, 400, 'missing path or name');
        deleteRepoContextFile(body.path, body.name);
        return jsonOk(res);
      } catch (e) {
        return jsonBodyErr(res, e);
      }
    })();
    return;
  }
  // Native macOS notifications. The browser POSTs here when it wants a real
  // Notification Center toast (in addition to / instead of the browser's own
  // Notification API which can be flaky). No-op on non-darwin platforms.
  if (url.pathname === '/api/notify' && req.method === 'POST') {
    (async () => {
      try {
        const body = await readJsonBody<{ kind?: string; sessionLabel?: string | null; body?: string; openUrl?: string }>(req);
        const kind = body.kind;
        if (typeof kind !== 'string' || !VALID_NOTIFY_KINDS.has(kind)) {
          return jsonErr(res, 400, 'invalid notify kind');
        }
        const transport = await notifyMac({
          kind: kind as MacNotifyKind,
          sessionLabel: body.sessionLabel ?? null,
          body: body.body,
          openUrl: body.openUrl,
        });
        return jsonOk(res, { transport });
      } catch (e) {
        return jsonBodyErr(res, e);
      }
    })();
    return;
  }
  if (url.pathname === '/api/notify/capabilities') {
    return jsonOk(res, { mac: isMacNotifySupported() });
  }
  // GET /api/logs/tail?id=<sessionId>&stream=<transcript|events|telemetry>&bytes=<N>
  // Returns the tail of one of the per-session log files. Bytes cap defaults to
  // 65536 (64KB) and is hard-capped at 1MB to keep the response small.
  if (url.pathname === '/api/logs/tail') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const id = url.searchParams.get('id') ?? '';
    const stream = (url.searchParams.get('stream') ?? 'transcript') as 'transcript' | 'events' | 'telemetry';
    const requestedBytes = Number(url.searchParams.get('bytes') ?? 65536);
    const maxBytes = Math.max(1024, Math.min(1_048_576, Number.isFinite(requestedBytes) ? requestedBytes : 65536));
    if (!id) return res.end(JSON.stringify({ ok: false, error: 'missing id' }));
    if (!/^[a-f0-9-]{8,}$/i.test(id)) return res.end(JSON.stringify({ ok: false, error: 'bad id' }));
    if (stream !== 'transcript' && stream !== 'events' && stream !== 'telemetry') {
      return res.end(JSON.stringify({ ok: false, error: 'bad stream' }));
    }
    const file = stream === 'transcript' ? 'transcript.log' : `${stream}.jsonl`;
    const fullPath = join(sessionLogDir(id), file);
    try {
      if (!existsSync(fullPath)) {
        return res.end(JSON.stringify({ ok: true, path: fullPath, size: 0, truncated: false, content: '' }));
      }
      const st = statSync(fullPath);
      const size = st.size;
      const readLen = Math.min(size, maxBytes);
      const start = size - readLen;
      const buf = Buffer.alloc(readLen);
      const fd = openSync(fullPath, 'r');
      try { readSync(fd, buf, 0, readLen, start); } finally { closeSync(fd); }
      let content = buf.toString('utf8');
      // Drop the (possibly partial) first line when we truncated from the front.
      const truncated = start > 0;
      if (truncated) {
        const nl = content.indexOf('\n');
        if (nl >= 0 && nl < content.length - 1) content = content.slice(nl + 1);
      }
      return res.end(JSON.stringify({ ok: true, path: fullPath, size, truncated, content }));
    } catch (e) {
      return res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
    }
  }
  // ─── Sessions API ────────────────────────────────────────────────────
  if (url.pathname === '/api/sessions/dormant') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const all = sessionManager.list();
    const dormant = all.filter((s) => s.dormant);
    return res.end(JSON.stringify({ ok: true, sessions: dormant }));
  }
  if (url.pathname === '/app.js') {
    const code = await bundleApp();
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(code);
  }
  // Serve macOS system sounds + user sounds so the chime picker can preview them.
  if (url.pathname === '/api/system-sounds') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const dirs = [
      { url: 'system', fs: '/System/Library/Sounds' },
      { url: 'user',   fs: `${process.env.HOME ?? ''}/Library/Sounds` },
    ];
    const out: Array<{ id: string; name: string; url: string; source: string }> = [];
    for (const d of dirs) {
      try {
        for (const f of readdirSync(d.fs)) {
          if (!/\.(aiff?|wav|mp3|m4a|caf)$/i.test(f)) continue;
          const name = f.replace(/\.[^.]+$/, '');
          out.push({ id: `${d.url}-${name}`, name, url: `/api/system-sound/${d.url}/${encodeURIComponent(f)}`, source: d.url });
        }
      } catch { /* directory missing — fine */ }
    }
    return res.end(JSON.stringify({ ok: true, sounds: out }));
  }
  if (url.pathname.startsWith('/api/system-sound/')) {
    const parts = url.pathname.slice('/api/system-sound/'.length).split('/');
    if (parts.length === 2 && (parts[0] === 'system' || parts[0] === 'user')) {
      const root = parts[0] === 'system' ? '/System/Library/Sounds' : `${process.env.HOME ?? ''}/Library/Sounds`;
      const file = decodeURIComponent(parts[1]);
      // Reject path traversal.
      if (!/^[A-Za-z0-9 _.\-()]+\.(aiff?|wav|mp3|m4a|caf)$/i.test(file)) {
        res.statusCode = 400;
        return res.end('bad filename');
      }
      const full = join(root, file);
      if (full.startsWith(root) && existsSync(full)) {
        const lower = file.toLowerCase();
        const isAiff = lower.endsWith('.aiff') || lower.endsWith('.aif') || lower.endsWith('.caf');
        // Chromium-family browsers (Chrome, Edge) can't decode AIFF/CAF in
        // either <audio> or Web Audio. Transcode to WAV via afconvert (ships
        // with macOS) and cache the result. WAV decode is universal.
        if (isAiff) {
          const wav = transcodeToWav(full);
          if (wav) {
            res.setHeader('Content-Type', 'audio/wav');
            res.setHeader('Cache-Control', 'no-cache');
            return res.end(readFileSync(wav));
          }
          // Fall through to raw bytes if transcode unexpectedly fails.
        }
        const ct = lower.endsWith('.wav') ? 'audio/wav'
          : lower.endsWith('.mp3') ? 'audio/mpeg'
          : lower.endsWith('.m4a') ? 'audio/mp4'
          : lower.endsWith('.caf') ? 'audio/x-caf'
          : 'audio/aiff';
        res.setHeader('Content-Type', ct);
        res.setHeader('Cache-Control', 'no-cache');
        return res.end(readFileSync(full));
      }
    }
    res.statusCode = 404;
    return res.end('not found');
  }
  const stat = serveStatic(url.pathname);
  if (stat) {
    res.setHeader('Content-Type', stat.contentType);
    return res.end(stat.body);
  }
  res.statusCode = 404;
  res.end('Not found');
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

function attach(ws: WebSocket, sessionId: string) {
  const map = wsAttachments.get(ws);
  if (!map) return;
  const existing = map.get(sessionId);
  if (existing) { try { existing(); } catch { /* ignore */ } }
  try {
    const { replay, unsubscribe } = sessionManager.attach(sessionId, (buf) => {
      sendPtyDataBinary(ws, sessionId, buf);
    });
    map.set(sessionId, unsubscribe);
    let bucket = attachedSockets.get(sessionId);
    if (!bucket) { bucket = new Set(); attachedSockets.set(sessionId, bucket); }
    bucket.add(ws);
    if (replay.length > 0) {
      sendPtyDataBinary(ws, sessionId, replay);
    }
  } catch (e) {
    send(ws, { t: 'error', id: sessionId, message: (e as Error).message });
  }
}

wss.on('connection', (ws) => {
  wsAttachments.set(ws, new Map());
  allSockets.add(ws);
  send(ws, { t: 'hello', protocolVersion: PROTOCOL_VERSION });
  send(ws, { t: 'session.list', sessions: sessionManager.list() });

  ws.on('message', (raw, isBinary) => {
    // Binary frame: PTY input on the hot path. Decode header + forward.
    if (isBinary) {
      const buf = raw as Buffer;
      if (buf.length < BIN_HEADER_SIZE) return;
      const tag = buf[0];
      if (tag === BIN_PTY_INPUT) {
        try {
          const sessionId = bytesToUuid(buf, 1);
          const payload = buf.subarray(BIN_HEADER_SIZE);
          sessionManager.input(sessionId, payload);
        } catch (e) {
          send(ws, { t: 'error', message: `binary input failed: ${(e as Error).message}` });
        }
      }
      return;
    }

    let msg: ClientMsg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : (raw as Buffer).toString('utf8'));
    } catch {
      send(ws, { t: 'error', message: 'invalid JSON' });
      return;
    }
    switch (msg.t) {
      case 'session.new': {
        try {
          // The WS handler doesn't accept arbitrary cmd[] anymore — the
          // server picks the bin. spawn() also validates internally, but
          // we strip it here so an old client that sends one gets a clear
          // server-chosen behavior instead of a reject.
          const meta = sessionManager.spawn({
            cwd: msg.cwd,
            repoPath: msg.repoPath,
            branchName: msg.branchName,
            baseBranch: msg.baseBranch,
          });
          broadcast({ t: 'session.created', session: meta });
          attach(ws, meta.id);
        } catch (e) {
          send(ws, { t: 'error', message: `spawn failed: ${(e as Error).message}` });
        }
        break;
      }
      case 'session.attach':
        attach(ws, msg.id);
        break;
      case 'session.resume':
        try {
          const meta = sessionManager.resume(msg.id);
          broadcast({ t: 'session.created', session: meta });
          attach(ws, meta.id);
        } catch (e) {
          send(ws, { t: 'error', id: msg.id, message: `resume failed: ${(e as Error).message}` });
        }
        break;
      case 'session.close':
        sessionManager.close(msg.id);
        break;
      case 'pty.input':
        // Legacy JSON path — kept for compatibility but binary frames are preferred.
        try {
          const data = Buffer.from(msg.data, 'base64');
          sessionManager.input(msg.id, data);
        } catch (e) {
          send(ws, { t: 'error', id: msg.id, message: (e as Error).message });
        }
        break;
      case 'pty.resize':
        sessionManager.resize(msg.id, msg.cols, msg.rows);
        break;
      default:
        send(ws, { t: 'error', message: `unknown message: ${(msg as { t: string }).t}` });
    }
  });

  ws.on('close', () => {
    const map = wsAttachments.get(ws);
    if (map) {
      for (const [sessionId, unsub] of map.entries()) {
        try { unsub(); } catch { /* ignore */ }
        attachedSockets.get(sessionId)?.delete(ws);
      }
    }
    wsAttachments.delete(ws);
    allSockets.delete(ws);
  });
});

sessionManager.on('exit', ({ id, exitCode, signal }: { id: string; exitCode: number | null; signal: string | null }) => {
  const msg: ServerMsg = { t: 'pty.exit', id, code: exitCode, signal };
  const bucket = attachedSockets.get(id);
  if (bucket) {
    for (const ws of bucket) send(ws, msg);
    attachedSockets.delete(id);
  }
});

sessionManager.on('status', ({ id, status, cause }: { id: string; status: SessionStatus; cause?: InputCause }) => {
  // Broadcast status to all sockets so the tab list / chime engine can react
  // even when the user isn't actively attached to the tab.
  broadcast({ t: 'session.status', id, status, ...(cause ? { cause } : {}) });
});

sessionManager.on('tool_failed', ({ id, tool }: { id: string; tool?: string }) => {
  // Side-channel signal — a single tool call returned failure but the
  // session is still running. The dashboard plays its tool-failed chime.
  broadcast({ t: 'session.tool_failed', id, ...(tool ? { tool } : {}) });
});

httpServer.listen(DEFAULTS.port, DEFAULTS.host, () => {
  const url = `http://${DEFAULTS.host}:${DEFAULTS.port}`;
  console.log(`[minionhq] listening on ${url}`);
  console.log(`[minionhq]   open ${url}  in your browser`);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[minionhq] ${signal} — shutting down...`);
  try {
    // Wait (up to SHUTDOWN_GRACE_MS) for all PTY onExit handlers to finish —
    // they own the worktree auto-commit, so cutting them off loses WIP.
    await sessionManager.shutdownAll();
  } catch { /* ignore */ }
  try { closeAllLogs(); } catch { /* ignore */ }
  try { wss.close(); } catch { /* ignore */ }
  try { httpServer.close(); } catch { /* ignore */ }
  try { closeDb(); } catch { /* ignore */ }
  // Small final grace so logs/db fsyncs flush before exit.
  setTimeout(() => process.exit(0), 100);
}
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
