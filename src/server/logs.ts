import { createWriteStream, existsSync, mkdirSync, statSync, renameSync, createReadStream, type WriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { join } from 'node:path';
import { sessionLogDir } from './paths.js';
import { db } from './db.js';

const MAX_BYTES = 50 * 1024 * 1024; // 50MB

interface Writers {
  pty: WriteStream;
  events: WriteStream;
  telemetry: WriteStream;
  ptyBytes: number;
}

const writers = new Map<string, Writers>();
// Per-session transcript sinks: a second PTY stream that writes into the
// per-repo transcripts dir so sessions on the same repo (any worktree) can
// `grep` across each other's output.
const transcriptSinks = new Map<string, WriteStream>();

function ensureWriters(sessionId: string): Writers {
  let w = writers.get(sessionId);
  if (w) return w;
  const dir = sessionLogDir(sessionId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const ptyPath = join(dir, 'pty.log');
  const ptyBytes = existsSync(ptyPath) ? statSync(ptyPath).size : 0;
  w = {
    pty: createWriteStream(ptyPath, { flags: 'a' }),
    events: createWriteStream(join(dir, 'events.jsonl'), { flags: 'a' }),
    telemetry: createWriteStream(join(dir, 'telemetry.jsonl'), { flags: 'a' }),
    ptyBytes,
  };
  writers.set(sessionId, w);
  return w;
}

function rotateIfNeeded(sessionId: string, w: Writers) {
  if (w.ptyBytes < MAX_BYTES) return;
  const dir = sessionLogDir(sessionId);
  const live = join(dir, 'pty.log');
  const rotated = join(dir, `pty.log.${Date.now()}`);
  try {
    w.pty.end();
    renameSync(live, rotated);
    const gzPath = `${rotated}.gz`;
    createReadStream(rotated).pipe(createGzip()).pipe(createWriteStream(gzPath))
      .on('finish', () => { try { require('node:fs').unlinkSync(rotated); } catch { /* ignore */ } });
    w.pty = createWriteStream(live, { flags: 'a' });
    w.ptyBytes = 0;
  } catch (e) {
    console.warn(`[logs] rotate failed for ${sessionId}:`, (e as Error).message);
  }
}

export function appendPty(sessionId: string, data: Buffer): void {
  const w = ensureWriters(sessionId);
  w.pty.write(data);
  w.ptyBytes += data.length;
  rotateIfNeeded(sessionId, w);
  // Tee into the per-repo transcripts dir (best-effort, write errors ignored).
  const sink = transcriptSinks.get(sessionId);
  if (sink) {
    try { sink.write(data); } catch { /* ignore */ }
  }
}

/**
 * Register a per-repo transcript sink for this session. PTY output written by
 * `appendPty` will also be appended to `<transcriptsDir>/<sessionId>.log`.
 * Idempotent — calling twice closes the previous sink first. A short header
 * line is written when the file is created so tail-readers know what they're
 * looking at.
 */
export function registerTranscriptSink(opts: {
  sessionId: string;
  transcriptsDir: string;
  branch: string;
}): void {
  const existing = transcriptSinks.get(opts.sessionId);
  if (existing) {
    try { existing.end(); } catch { /* ignore */ }
    transcriptSinks.delete(opts.sessionId);
  }
  try {
    if (!existsSync(opts.transcriptsDir)) mkdirSync(opts.transcriptsDir, { recursive: true });
    const path = join(opts.transcriptsDir, `${opts.sessionId}.log`);
    const fresh = !existsSync(path);
    const stream = createWriteStream(path, { flags: 'a' });
    if (fresh) {
      stream.write(
        `# minionhq transcript\n# session: ${opts.sessionId}\n# branch:  ${opts.branch}\n# started: ${new Date().toISOString()}\n\n`,
      );
    } else {
      stream.write(`\n# --- resumed ${new Date().toISOString()} (branch ${opts.branch}) ---\n\n`);
    }
    transcriptSinks.set(opts.sessionId, stream);
  } catch (e) {
    console.warn(`[logs] transcript sink open failed for ${opts.sessionId}:`, (e as Error).message);
  }
}

export function closeTranscriptSink(sessionId: string): void {
  const sink = transcriptSinks.get(sessionId);
  if (!sink) return;
  try { sink.end(); } catch { /* ignore */ }
  transcriptSinks.delete(sessionId);
}

export function logEvent(sessionId: string, kind: string, payload: unknown = null): void {
  const ts = Date.now();
  const line = JSON.stringify({ ts, kind, payload }) + '\n';
  ensureWriters(sessionId).events.write(line);
  try {
    db().prepare('INSERT INTO events (session_id, ts, kind, payload_json) VALUES (?, ?, ?, ?)')
      .run(sessionId, ts, kind, payload == null ? null : JSON.stringify(payload));
  } catch (e) {
    console.warn(`[logs] db event write failed:`, (e as Error).message);
  }
}

export interface TelemetryRow {
  kind: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  toolName?: string;
  success?: boolean;
  payload?: unknown;
}

export function logTelemetry(sessionId: string, row: TelemetryRow): void {
  const ts = Date.now();
  const line = JSON.stringify({ ts, ...row }) + '\n';
  ensureWriters(sessionId).telemetry.write(line);
  try {
    db().prepare(
      `INSERT INTO telemetry (session_id, ts, kind, model, input_tokens, output_tokens, duration_ms, tool_name, success, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sessionId, ts, row.kind,
      row.model ?? null,
      row.inputTokens ?? null,
      row.outputTokens ?? null,
      row.durationMs ?? null,
      row.toolName ?? null,
      row.success == null ? null : (row.success ? 1 : 0),
      row.payload == null ? null : JSON.stringify(row.payload),
    );
  } catch (e) {
    console.warn(`[logs] db telemetry write failed:`, (e as Error).message);
  }
}

export function closeSessionLogs(sessionId: string): void {
  const w = writers.get(sessionId);
  if (w) {
    try { w.pty.end(); } catch { /* ignore */ }
    try { w.events.end(); } catch { /* ignore */ }
    try { w.telemetry.end(); } catch { /* ignore */ }
    writers.delete(sessionId);
  }
  closeTranscriptSink(sessionId);
}

export function closeAllLogs(): void {
  for (const id of [...writers.keys()]) closeSessionLogs(id);
  for (const id of [...transcriptSinks.keys()]) closeTranscriptSink(id);
}
