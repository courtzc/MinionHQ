import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import pty from 'node-pty';
import type { IPty } from 'node-pty';
import { db } from './db.js';
import { appendPty, closeSessionLogs, logEvent } from './logs.js';
import { DEFAULTS } from './paths.js';
import { createWorktree, saveWorktreeWork, isGitRepo } from './worktrees.js';
import { setupWorktreeContext } from './context.js';
import { classify } from './statusClassifier.js';
import { RingBuffer } from './ringBuffer.js';
import type { SessionMeta, SessionStatus } from '../shared/protocol.js';

const REPLAY_MAX = 256 * 1024;
const COPILOT_SESSION_ID_RE = /session[ _-]?id[:=]\s*([0-9a-f-]{8,})/i;

interface Internal {
  meta: SessionMeta;
  pty: IPty;
  replay: RingBuffer;
  subscribers: Set<(buf: Buffer) => void>;
}

class SessionManager extends EventEmitter {
  private sessions = new Map<string, Internal>();

  list(): SessionMeta[] {
    return [...this.sessions.values()].map((s) => ({ ...s.meta }));
  }

  get(id: string): SessionMeta | null {
    const s = this.sessions.get(id);
    return s ? { ...s.meta } : null;
  }

  spawn(opts: { cwd?: string; cmd?: string[]; repoPath?: string; branchName?: string; baseBranch?: string } = {}): SessionMeta {
    const id = randomUUID();
    let cwd = opts.cwd ?? process.cwd();
    const cmd = opts.cmd && opts.cmd.length > 0 ? opts.cmd : [DEFAULTS.copilotBin];
    const [bin, ...args] = cmd;

    let repoPath: string | null = null;
    let worktreePath: string | null = null;
    let branch: string | null = null;

    // If a repoPath is given (or the cwd is a git repo) and the caller asked
    // for branch-per-session, create a worktree.
    const target = opts.repoPath ?? opts.cwd;
    if (target && isGitRepo(target)) {
      try {
        const wt = createWorktree({
          sessionId: id,
          repoPath: target,
          branchName: opts.branchName,
          baseBranch: opts.baseBranch,
        });
        repoPath = wt.repoPath;
        worktreePath = wt.worktreePath;
        branch = wt.branch;
        cwd = wt.worktreePath;

        // Set up per-repo central context symlink + AGENTS.md inside the worktree
        try {
          const ctx = setupWorktreeContext({
            worktreePath: wt.worktreePath,
            repoRealPath: wt.repoPath,
            branch: wt.branch,
          });
          logEvent(id, 'context.setup', { agentsPath: ctx.agentsPath, centralDir: ctx.centralDir });
        } catch (e) {
          logEvent(id, 'context.setup_failed', { message: (e as Error).message });
        }
      } catch (e) {
        logEvent(id, 'worktree.failed', { message: (e as Error).message });
        // Fall back to spawning directly in target without worktree
      }
    }

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v;
    }
    // Ensure local bin is on PATH (copilot often lives in ~/.local/bin)
    const localBin = `${homedir()}/.local/bin`;
    if (!env.PATH?.split(':').includes(localBin)) {
      env.PATH = `${localBin}:${env.PATH ?? ''}`;
    }
    env.TERM = env.TERM ?? 'xterm-256color';

    const proc = pty.spawn(bin, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd,
      env,
    });

    const now = Date.now();
    const meta: SessionMeta = {
      id,
      cwd,
      cmd,
      status: 'spawning',
      createdAt: now,
      updatedAt: now,
      copilotSessionId: null,
      title: branch ?? null,
      repoPath,
      worktreePath,
      branch,
    };

    const internal: Internal = {
      meta,
      pty: proc,
      replay: new RingBuffer(REPLAY_MAX),
      subscribers: new Set(),
    };
    this.sessions.set(id, internal);

    try {
      db().prepare(
        `INSERT INTO sessions (id, cwd, cmd, status, created_at, updated_at, branch, worktree_path, repo_path, title)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, cwd, JSON.stringify(cmd), meta.status, now, now, branch, worktreePath, repoPath, meta.title ?? null);
    } catch (e) {
      console.warn('[sessions] db insert failed:', (e as Error).message);
    }
    logEvent(id, 'session.spawned', { cwd, cmd, repoPath, worktreePath, branch });

    proc.onData((chunk) => {
      const buf = Buffer.from(chunk, 'utf8');
      appendPty(id, buf);

      // O(1) amortised append into a fixed-cap ring buffer.
      internal.replay.append(buf);

      // Detect copilot session id (best-effort heuristic; replaced in Phase 3 parser)
      if (!meta.copilotSessionId) {
        const text = buf.toString('utf8');
        const m = text.match(COPILOT_SESSION_ID_RE);
        if (m) {
          meta.copilotSessionId = m[1];
          try {
            db().prepare('UPDATE sessions SET copilot_session_id = ? WHERE id = ?').run(m[1], id);
          } catch { /* ignore */ }
          logEvent(id, 'session.copilot_id', { copilotSessionId: m[1] });
        }
      }

      // First chunk implies the process is alive and accepting output → idle
      if (meta.status === 'spawning') {
        this.setStatus(id, 'idle');
      } else {
        const next = classify(buf, meta.status);
        if (next && next !== meta.status) this.setStatus(id, next);
      }

      // Fan out to subscribers
      for (const fn of internal.subscribers) {
        try { fn(buf); } catch { /* ignore */ }
      }
    });

    proc.onExit(({ exitCode, signal }) => {
      meta.status = 'exited';
      meta.updatedAt = Date.now();
      try {
        db().prepare('UPDATE sessions SET status = ?, updated_at = ?, closed_at = ? WHERE id = ?')
          .run('exited', meta.updatedAt, meta.updatedAt, id);
      } catch { /* ignore */ }
      logEvent(id, 'session.exited', { exitCode, signal });
      this.emit('exit', { id, exitCode, signal: signal != null ? String(signal) : null });

      // SAFETY: auto-commit any uncommitted work in the worktree so nothing
      // the agent did is lost. The branch + worktree DIRECTORY are kept on
      // disk; only the PTY process exits. Explicit archive is a separate op.
      if (meta.worktreePath) {
        try {
          const result = saveWorktreeWork(meta.worktreePath, id);
          if (result.error) {
            logEvent(id, 'worktree.save_failed', { error: result.error });
          } else if (result.committed) {
            logEvent(id, 'worktree.saved', {
              commitSha: result.commitSha,
              message: result.message,
              pushed: result.pushed,
            });
          }
        } catch (e) {
          logEvent(id, 'worktree.save_threw', { message: (e as Error).message });
        }
      }
      closeSessionLogs(id);
      this.sessions.delete(id);
    });

    return { ...meta };
  }

  attach(id: string, onData: (buf: Buffer) => void): { replay: Buffer; unsubscribe: () => void } {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`session not found: ${id}`);
    s.subscribers.add(onData);
    return {
      replay: s.replay.snapshot(),
      unsubscribe: () => { s.subscribers.delete(onData); },
    };
  }

  input(id: string, data: Buffer): void {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`session not found: ${id}`);
    s.pty.write(data.toString('utf8'));
    if (s.meta.status === 'needs-input') this.setStatus(id, 'working');
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (!s) return;
    try { s.pty.resize(Math.max(2, cols), Math.max(2, rows)); } catch { /* ignore */ }
  }

  close(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    try { s.pty.kill(); } catch { /* ignore */ }
  }

  setStatus(id: string, status: SessionStatus): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.meta.status === status) return;
    s.meta.status = status;
    s.meta.updatedAt = Date.now();
    try {
      db().prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, s.meta.updatedAt, id);
    } catch { /* ignore */ }
    this.emit('status', { id, status });
  }

  shutdownAll(): void {
    for (const s of this.sessions.values()) {
      try { s.pty.kill(); } catch { /* ignore */ }
    }
  }
}

export const sessionManager = new SessionManager();
