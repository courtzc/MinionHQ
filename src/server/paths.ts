import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ROOT_DIR = process.env.MINIONHQ_HOME
  ? join(process.env.MINIONHQ_HOME)
  : join(homedir(), '.minionhq');
export const LOGS_DIR = join(ROOT_DIR, 'logs');
export const WORKTREE_DIR = join(ROOT_DIR, 'wt');
export const REPOS_DIR = join(ROOT_DIR, 'repos');
export const ATTACHMENTS_DIR = join(ROOT_DIR, 'attachments');
export const DB_PATH = join(ROOT_DIR, 'db.sqlite');
export const CONFIG_PATH = join(ROOT_DIR, 'config.json');

export const DEFAULTS = {
  host: process.env.MINIONHQ_HOST ?? '127.0.0.1',
  port: Number(process.env.MINIONHQ_PORT ?? 4242),
  copilotBin: process.env.MINIONHQ_COPILOT_BIN ?? 'copilot',
  // Default base for repo discovery. Users can override at runtime via the
  // "change base" link in the New-session modal; the env var sets the
  // initial default so day-zero installs find their repos automatically.
  reposBase: process.env.MINIONHQ_REPOS_BASE ?? join(homedir(), 'repositories'),
};

export function ensureDirs() {
  for (const d of [ROOT_DIR, LOGS_DIR, WORKTREE_DIR, REPOS_DIR, ATTACHMENTS_DIR]) {
    mkdirSync(d, { recursive: true });
  }
}

export function sessionLogDir(sessionId: string) {
  return join(LOGS_DIR, sessionId);
}

export function sessionAttachmentsDir(sessionId: string) {
  return join(ATTACHMENTS_DIR, sessionId);
}
