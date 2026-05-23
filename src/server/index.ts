import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import * as esbuild from 'esbuild';

import { sessionManager } from './sessions.js';
import { db, closeDb } from './db.js';
import { ensureDirs, DEFAULTS } from './paths.js';
import { closeAllLogs } from './logs.js';
import {
  PROTOCOL_VERSION,
  type ClientMsg,
  type ServerMsg,
  type SessionStatus,
} from '../shared/protocol.js';

ensureDirs();
db(); // initialise + migrate

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

const wsAttachments = new WeakMap<WebSocket, Map<string, () => void>>();
const attachedSockets = new Map<string, Set<WebSocket>>();

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

const httpServer = createServer(async (req, res) => {
  if (!req.url) { res.statusCode = 400; return res.end('Bad request'); }
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/api/health') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION }));
  }
  if (url.pathname === '/app.js') {
    const code = await bundleApp();
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(code);
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
      send(ws, { t: 'pty.data', id: sessionId, data: buf.toString('base64') });
    });
    map.set(sessionId, unsubscribe);
    let bucket = attachedSockets.get(sessionId);
    if (!bucket) { bucket = new Set(); attachedSockets.set(sessionId, bucket); }
    bucket.add(ws);
    if (replay.length > 0) {
      send(ws, { t: 'pty.data', id: sessionId, data: replay.toString('base64') });
    }
  } catch (e) {
    send(ws, { t: 'error', id: sessionId, message: (e as Error).message });
  }
}

wss.on('connection', (ws) => {
  wsAttachments.set(ws, new Map());
  send(ws, { t: 'hello', protocolVersion: PROTOCOL_VERSION });
  send(ws, { t: 'session.list', sessions: sessionManager.list() });

  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
      send(ws, { t: 'error', message: 'invalid JSON' });
      return;
    }
    switch (msg.t) {
      case 'session.new': {
        try {
          const meta = sessionManager.spawn({ cwd: msg.cwd, cmd: msg.cmd });
          send(ws, { t: 'session.created', session: meta });
          attach(ws, meta.id);
        } catch (e) {
          send(ws, { t: 'error', message: `spawn failed: ${(e as Error).message}` });
        }
        break;
      }
      case 'session.attach':
        attach(ws, msg.id);
        break;
      case 'session.close':
        sessionManager.close(msg.id);
        break;
      case 'pty.input':
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

sessionManager.on('status', ({ id, status }: { id: string; status: SessionStatus }) => {
  const msg: ServerMsg = { t: 'session.status', id, status };
  const bucket = attachedSockets.get(id);
  if (bucket) for (const ws of bucket) send(ws, msg);
});

httpServer.listen(DEFAULTS.port, DEFAULTS.host, () => {
  const url = `http://${DEFAULTS.host}:${DEFAULTS.port}`;
  console.log(`[copilot-multi] listening on ${url}`);
  console.log(`[copilot-multi]   open ${url}  in your browser`);
});

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[copilot-multi] ${signal} — shutting down...`);
  sessionManager.shutdownAll();
  closeAllLogs();
  wss.close();
  httpServer.close();
  closeDb();
  setTimeout(() => process.exit(0), 250);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
