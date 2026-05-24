import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readJsonBody } from '../src/server/httpUtil.js';

function startEcho(maxBytes?: number, timeoutMs?: number) {
  const server = createServer((req, res) => {
    readJsonBody(req, maxBytes, timeoutMs).then(
      (body) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, body }));
      },
      (err: Error & { code?: string }) => {
        res.statusCode = err.code === 'ERR_BODY_TOO_LARGE' ? 413
          : err.code === 'ERR_BODY_TIMEOUT' ? 408
          : 400;
        res.end(JSON.stringify({ ok: false, error: err.message, code: err.code }));
      },
    );
  });
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function post(url: string, body: string | Buffer): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest({
      method: 'POST',
      host: u.hostname,
      port: u.port,
      path: '/',
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('readJsonBody: happy path parses JSON', async () => {
  const s = await startEcho();
  try {
    const { status, text } = await post(s.url, JSON.stringify({ hello: 'world' }));
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(text), { ok: true, body: { hello: 'world' } });
  } finally {
    await s.close();
  }
});

test('readJsonBody: oversize body → 413', async () => {
  const s = await startEcho(32);
  try {
    const big = JSON.stringify({ blob: 'x'.repeat(200) });
    const { status, text } = await post(s.url, big);
    assert.equal(status, 413);
    assert.match(text, /too large/);
  } finally {
    await s.close();
  }
});

test('readJsonBody: malformed JSON → 400', async () => {
  const s = await startEcho();
  try {
    const { status } = await post(s.url, '{not json');
    assert.equal(status, 400);
  } finally {
    await s.close();
  }
});

test('readJsonBody: empty body parses as {}', async () => {
  const s = await startEcho();
  try {
    const { status, text } = await post(s.url, '');
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(text), { ok: true, body: {} });
  } finally {
    await s.close();
  }
});
