#!/usr/bin/env node
// Fix node-pty's spawn-helper exec bit on macOS.
// Inspired by claudecodeui/scripts/fix-node-pty.js.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function fix() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  const base = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
  const dirs = process.platform === 'darwin'
    ? ['darwin-arm64', 'darwin-x64']
    : ['linux-x64', 'linux-arm64'];
  for (const d of dirs) {
    const p = path.join(base, d, 'spawn-helper');
    try {
      await fs.access(p);
      await fs.chmod(p, 0o755);
      console.log(`[postinstall] chmod +x ${p}`);
    } catch (e) {
      if (e && e.code !== 'ENOENT') {
        console.warn(`[postinstall] warn ${p}: ${e.message}`);
      }
    }
  }
}

fix().catch((e) => { console.error('[postinstall] failed:', e); });
