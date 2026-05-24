import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ROOT_DIR = join(homedir(), '.copilot-multi');
export const LOGS_DIR = join(ROOT_DIR, 'logs');
export const WORKTREE_DIR = join(ROOT_DIR, 'wt');
export const REPOS_DIR = join(ROOT_DIR, 'repos');
export const DB_PATH = join(ROOT_DIR, 'db.sqlite');
export const CONFIG_PATH = join(ROOT_DIR, 'config.json');

export const DEFAULTS = {
  host: process.env.COPILOT_MULTI_HOST ?? '127.0.0.1',
  port: Number(process.env.COPILOT_MULTI_PORT ?? 4242),
  copilotBin: process.env.COPILOT_MULTI_BIN ?? 'copilot',
};

export function ensureDirs() {
  for (const d of [ROOT_DIR, LOGS_DIR, WORKTREE_DIR, REPOS_DIR]) {
    mkdirSync(d, { recursive: true });
  }
}

export function sessionLogDir(sessionId: string) {
  return join(LOGS_DIR, sessionId);
}
