import type { IncomingMessage, ServerResponse } from 'node:http';
import { LIMITS } from './limits.js';

/**
 * Read a JSON body with a size cap and timeout. Rejects on:
 *   - oversize     → 413 from caller
 *   - timeout      → 408 from caller
 *   - parse error  → 400 from caller
 *   - aborted req  → 400 from caller
 *
 * Returns the parsed object on success.
 */
export function readJsonBody<T = unknown>(
  req: IncomingMessage,
  maxBytes: number = LIMITS.MAX_BODY_BYTES,
  timeoutMs: number = LIMITS.BODY_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolveBody, rejectBody) => {
    let total = 0;
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (err: Error | null, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onErr);
      req.removeListener('aborted', onAbort);
      if (err) rejectBody(err);
      else resolveBody(value as T);
    };

    const onData = (c: Buffer | string) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      total += buf.length;
      if (total > maxBytes) {
        const err = new Error(`body too large (> ${maxBytes} bytes)`);
        (err as Error & { code?: string }).code = 'ERR_BODY_TOO_LARGE';
        // Don't destroy the socket here — we want the caller to be able to
        // respond with 413. Just stop accumulating and resume the stream
        // so Node's HTTP layer can finish reading without backpressure.
        req.resume();
        finish(err);
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const parsed = text ? (JSON.parse(text) as T) : ({} as T);
        finish(null, parsed);
      } catch (e) {
        finish(e as Error);
      }
    };

    const onErr = (e: Error) => finish(e);
    const onAbort = () => finish(new Error('request aborted'));

    const timer = setTimeout(() => {
      const err = new Error(`body read timed out after ${timeoutMs}ms`);
      (err as Error & { code?: string }).code = 'ERR_BODY_TIMEOUT';
      req.resume();
      finish(err);
    }, timeoutMs);

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onErr);
    req.on('aborted', onAbort);
  });
}

export function jsonOk(res: ServerResponse, data: Record<string, unknown> = {}): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: true, ...data }));
}

export function jsonErr(res: ServerResponse, status: number, error: string, extra: Record<string, unknown> = {}): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: false, error, ...extra }));
}

/** Translate readJsonBody errors into the right HTTP status + body. */
export function jsonBodyErr(res: ServerResponse, e: unknown): void {
  const err = e as Error & { code?: string };
  if (err.code === 'ERR_BODY_TOO_LARGE') return jsonErr(res, 413, err.message);
  if (err.code === 'ERR_BODY_TIMEOUT') return jsonErr(res, 408, err.message);
  return jsonErr(res, 400, err.message || 'bad request');
}
