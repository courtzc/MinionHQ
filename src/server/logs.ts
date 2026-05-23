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
  if (!w) return;
  try { w.pty.end(); } catch { /* ignore */ }
  try { w.events.end(); } catch { /* ignore */ }
  try { w.telemetry.end(); } catch { /* ignore */ }
  writers.delete(sessionId);
}

export function closeAllLogs(): void {
  for (const id of [...writers.keys()]) closeSessionLogs(id);
}
