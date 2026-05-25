import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, existsSync, openSync, closeSync, readSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pty from 'node-pty';
import type { IPty } from 'node-pty';
import { db } from './db.js';
import { appendPty, closeSessionLogs, logEvent, registerTranscriptSink } from './logs.js';
import { DEFAULTS } from './paths.js';
import { LIMITS } from './limits.js';
import { createWorktree, saveWorktreeWork, isGitRepo, repoToplevel } from './worktrees.js';
import { setupWorktreeContext, appendTranscriptIndex } from './context.js';
import { RingBuffer } from './ringBuffer.js';
import type { SessionMeta, SessionStatus } from '../shared/protocol.js';

const REPLAY_MAX = 256 * 1024;
const SESSION_STATE_ROOT = join(homedir(), '.copilot', 'session-state');

/**
 * Whitelist for the cmd[] passed to pty.spawn. Only the configured Copilot
 * binary is allowed, with a small set of safe args. Anything else is rejected
 * — this prevents RCE via a forged WebSocket message setting cmd=['rm','-rf','/'].
 */
function validateCmd(cmd: string[]): { ok: true } | { ok: false; reason: string } {
  if (!Array.isArray(cmd) || cmd.length === 0) {
    return { ok: false, reason: 'cmd must be a non-empty array' };
  }
  const [bin, ...args] = cmd;
  if (bin !== DEFAULTS.copilotBin) {
    return { ok: false, reason: `bin must be ${DEFAULTS.copilotBin} (got ${JSON.stringify(bin)})` };
  }
  for (const a of args) {
    if (typeof a !== 'string') return { ok: false, reason: 'all args must be strings' };
    if (a === '--continue') continue;
    if (/^--resume=[A-Za-z0-9_-]+$/.test(a)) continue;
    return { ok: false, reason: `arg not allowed: ${JSON.stringify(a)}` };
  }
  return { ok: true };
}

function repoToplevelSafe(p: string): string {
  try { return repoToplevel(p); } catch { return p; }
}

/**
 * Pre-trust a folder by adding it to Copilot CLI's ~/.copilot/config.json
 * trustedFolders array. Without this, every new worktree triggers a blocking
 * "Confirm folder trust" prompt on session start.
 */
function preTrustFolder(folder: string): void {
  const configPath = join(homedir(), '.copilot', 'config.json');
  if (!existsSync(configPath)) return;
  try {
    const raw = readFileSync(configPath, 'utf-8');
    // Strip leading "// ..." comment lines that Copilot's config has
    const jsonStr = raw.replace(/^\s*\/\/[^\n]*\n/gm, '');
    const cfg = JSON.parse(jsonStr);
    const list: string[] = Array.isArray(cfg.trustedFolders) ? cfg.trustedFolders : [];
    if (list.includes(folder)) return;
    list.push(folder);
    cfg.trustedFolders = list;
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  } catch {
    // Non-fatal: Copilot will just prompt the user, which is the existing UX.
  }
}

interface Internal {
  meta: SessionMeta;
  pty: IPty | null;
  replay: RingBuffer;
  subscribers: Set<(buf: Buffer) => void>;
  /** Set after resume(); listens for Copilot's "Session in use" prompt and auto-answers. */
  resumeAutoAnswer?: {
    scanned: number;       // bytes scanned so far
    deadline: number;      // ms epoch after which we give up
    text: string;          // accumulated text for cross-chunk regex matching
    answered: boolean;     // already pressed Enter
  };
  /** Once resolved, the path of ~/.copilot/session-state/<copilotSessionId>. */
  copilotSessionDir: string | null;
  /** Polls inuse.<PID>.lock to discover the CLI's session UUID. */
  resolveTimer: NodeJS.Timeout | null;
  /** Polls events.jsonl for typed CLI events that drive status/chimes. */
  tailFd: number | null;
  tailOffset: number;
  tailTimer: NodeJS.Timeout | null;
  /** Track tool.execution_start timestamps for duration telemetry. */
  toolStartTs: Map<string, { name: string; ts: number }>;
}

const RESUME_AUTOANSWER_MAX_BYTES = 32 * 1024;
const RESUME_AUTOANSWER_MAX_MS = 8000;
const RESUME_PROMPT_RE = /Session in use|Resume anyway/i;

/**
 * Tools whose execution blocks the turn waiting on user input. The CLI doesn't
 * emit `permission.requested` for these (they're not permission gates), they
 * just stop until the user picks. We treat tool.execution_start for any of
 * these as a needs-input signal so the chime + OS notification still fire.
 */
const INTERACTIVE_TOOLS = new Set<string>([
  'ask_user',
]);

class SessionManager extends EventEmitter {
  private sessions = new Map<string, Internal>();
  /** Resolves once a session's onExit handler completes. Used by shutdownAll. */
  private exitPromises = new Map<string, Promise<void>>();

  list(): SessionMeta[] {
    return [...this.sessions.values()].map((s) => ({ ...s.meta }));
  }

  get(id: string): SessionMeta | null {
    const s = this.sessions.get(id);
    return s ? { ...s.meta } : null;
  }

  spawn(opts: { cwd?: string; cmd?: string[]; repoPath?: string; branchName?: string; baseBranch?: string } = {}): SessionMeta {
    // ─── Smart reuse: if a dormant session already exists for this repo+branch,
    // resume that one instead of creating a fresh worktree with a -2 suffix.
    if (opts.repoPath && opts.branchName) {
      const targetRepo = isGitRepo(opts.repoPath) ? repoToplevelSafe(opts.repoPath) : opts.repoPath;
      const wantBranch = opts.branchName.trim();
      for (const s of this.sessions.values()) {
        if (s.pty) continue; // skip live sessions
        if (s.meta.branch !== wantBranch) continue;
        if (s.meta.repoPath !== targetRepo) continue;
        if (!s.meta.worktreePath || !existsSync(s.meta.worktreePath)) continue;
        // Match — resume this dormant session.
        logEvent(s.meta.id, 'session.reused', { reason: 'spawn matched dormant repo+branch' });
        return this.resume(s.meta.id);
      }
    }

    const id = randomUUID();
    let cwd = opts.cwd ?? process.cwd();
    const cmd = opts.cmd && opts.cmd.length > 0 ? opts.cmd : [DEFAULTS.copilotBin];
    const cmdCheck = validateCmd(cmd);
    if (!cmdCheck.ok) throw new Error(`cmd rejected: ${cmdCheck.reason}`);

    const liveCount = [...this.sessions.values()].filter((s) => s.pty != null).length;
    if (liveCount >= LIMITS.MAX_LIVE_SESSIONS) {
      throw new Error(`max live sessions reached (${LIMITS.MAX_LIVE_SESSIONS}); close one and try again`);
    }

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
          // Register the per-repo transcript sink so all PTY output for this
          // session also lands in ~/.minionhq/repos/<key>/transcripts/<id>.log
          // (visible from every worktree of this repo via the symlink).
          registerTranscriptSink({
            sessionId: id,
            transcriptsDir: ctx.transcriptsDir,
            branch: wt.branch,
          });
          appendTranscriptIndex({
            repoRealPath: wt.repoPath,
            sessionId: id,
            branch: wt.branch,
            startedAt: Date.now(),
          });
        } catch (e) {
          logEvent(id, 'context.setup_failed', { message: (e as Error).message });
        }
      } catch (e) {
        logEvent(id, 'worktree.failed', { message: (e as Error).message });
        // Fall back to spawning directly in target without worktree
      }
    }

    const proc = this.spawnPty(bin, args, cwd, worktreePath);

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
      dormant: false,
    };

    const internal: Internal = {
      meta,
      pty: proc,
      replay: new RingBuffer(REPLAY_MAX),
      subscribers: new Set(),
      copilotSessionDir: null,
      resolveTimer: null,
      tailFd: null,
      tailOffset: 0,
      tailTimer: null,
      toolStartTs: new Map(),
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

    this.wirePty(id);
    return { ...meta };
  }

  /**
   * Build the env + pty.spawn call. Pre-trusts the worktree folder.
   */
  private spawnPty(bin: string, args: string[], cwd: string, worktreePath: string | null): IPty {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v;
    }
    const localBin = `${homedir()}/.local/bin`;
    if (!env.PATH?.split(':').includes(localBin)) {
      env.PATH = `${localBin}:${env.PATH ?? ''}`;
    }
    env.TERM = env.TERM ?? 'xterm-256color';

    if (worktreePath) preTrustFolder(worktreePath);

    return pty.spawn(bin, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd,
      env,
    });
  }

  /**
   * Attach onData/onExit handlers to the PTY of the session with the given id.
   * Called both by spawn() (fresh session) and resume() (resumed dormant session).
   */
  private wirePty(id: string): void {
    const internal = this.sessions.get(id);
    if (!internal || !internal.pty) return;
    const meta = internal.meta;
    const proc = internal.pty;

    // Track this session's eventual onExit completion so shutdownAll can await it.
    let resolveExit!: () => void;
    this.exitPromises.set(id, new Promise<void>((r) => { resolveExit = r; }));

    proc.onData((chunk) => {
      const buf = Buffer.from(chunk, 'utf8');
      appendPty(id, buf);
      internal.replay.append(buf);

      // ─── Auto-answer Copilot's "Session in use" resume prompt.
      const raa = internal.resumeAutoAnswer;
      if (raa && !raa.answered) {
        raa.scanned += buf.length;
        raa.text += buf.toString('utf8');
        // Cap accumulated text to keep regex cheap.
        if (raa.text.length > RESUME_AUTOANSWER_MAX_BYTES) {
          raa.text = raa.text.slice(-RESUME_AUTOANSWER_MAX_BYTES);
        }
        const expired = Date.now() > raa.deadline || raa.scanned > RESUME_AUTOANSWER_MAX_BYTES;
        if (RESUME_PROMPT_RE.test(raa.text)) {
          raa.answered = true;
          // Default highlight is option 1 ("Resume anyway") — Enter selects it.
          try { proc.write('\r'); } catch { /* ignore */ }
          logEvent(id, 'session.resume_autoanswered', {});
          internal.resumeAutoAnswer = undefined;
        } else if (expired) {
          internal.resumeAutoAnswer = undefined;
        }
      }

      // copilotSessionId is resolved by the sidecar (inuse.<pid>.lock → dir name).
      // Status transitions are driven by events.jsonl in the sidecar — not by
      // PTY-byte regex. The only PTY-derived transition we keep is the initial
      // spawning → idle flip on first byte, so the UI doesn't sit on "spawning"
      // until the JSONL stream catches up.
      if (meta.status === 'spawning') {
        this.setStatus(id, 'idle');
      }

      for (const fn of internal.subscribers) {
        try { fn(buf); } catch { /* ignore */ }
      }
    });

    proc.onExit(({ exitCode, signal }) => {
      this.stopResolver(internal);
      this.stopTail(internal);
      meta.status = 'exited';
      meta.updatedAt = Date.now();
      meta.dormant = true;
      try {
        db().prepare('UPDATE sessions SET status = ?, updated_at = ?, closed_at = ? WHERE id = ?')
          .run('exited', meta.updatedAt, meta.updatedAt, id);
      } catch { /* ignore */ }
      logEvent(id, 'session.exited', { exitCode, signal });
      this.emit('exit', { id, exitCode, signal: signal != null ? String(signal) : null });

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
      // Keep the entry in the map so it's resumable. Just drop the live pty.
      internal.pty = null;
      this.exitPromises.delete(id);
      resolveExit();
    });

    // Kick off sidecar resolver — once the inuse.<pid>.lock appears we'll know
    // the CLI's session UUID and can start tailing events.jsonl.
    this.startResolver(internal);
  }

  /**
   * Resume a dormant session by spawning a fresh Copilot CLI process with
   * --resume=<copilotSessionId> (or --continue if we never captured the id)
   * in the existing worktree. Same session id, same DB row.
   */
  resume(id: string): SessionMeta {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`session not found: ${id}`);
    if (s.pty) throw new Error(`session already alive: ${id}`);
    const meta = s.meta;
    if (!meta.worktreePath || !existsSync(meta.worktreePath)) {
      throw new Error(`worktree missing for session ${id}: ${meta.worktreePath ?? '(none)'}`);
    }

    // Build cmd: base bin + --resume=<copilotId> if known else --continue.
    // Force the bin back to the trusted DEFAULTS.copilotBin in case a stale
    // DB row has something else stored.
    const baseBin = DEFAULTS.copilotBin;
    const resumeArg = meta.copilotSessionId && /^[A-Za-z0-9_-]+$/.test(meta.copilotSessionId)
      ? `--resume=${meta.copilotSessionId}`
      : '--continue';
    const cmd = [baseBin, resumeArg];
    const check = validateCmd(cmd);
    if (!check.ok) throw new Error(`resume cmd rejected: ${check.reason}`);

    const liveCount = [...this.sessions.values()].filter((x) => x.pty != null).length;
    if (liveCount >= LIMITS.MAX_LIVE_SESSIONS) {
      throw new Error(`max live sessions reached (${LIMITS.MAX_LIVE_SESSIONS})`);
    }

    logEvent(id, 'session.resuming', { cmd, worktreePath: meta.worktreePath });
    const proc = this.spawnPty(baseBin, [resumeArg], meta.worktreePath, meta.worktreePath);

    s.pty = proc;
    s.replay = new RingBuffer(REPLAY_MAX);
    s.resumeAutoAnswer = {
      scanned: 0,
      deadline: Date.now() + RESUME_AUTOANSWER_MAX_MS,
      text: '',
      answered: false,
    };
    meta.status = 'spawning';
    meta.dormant = false;
    meta.cmd = cmd;
    meta.updatedAt = Date.now();

    // Re-register the per-repo transcript sink so resumed sessions continue
    // appending into the same archive file (with a "resumed at" marker).
    if (meta.repoPath) {
      try {
        const ctx = setupWorktreeContext({
          worktreePath: meta.worktreePath,
          repoRealPath: meta.repoPath,
          branch: meta.branch ?? 'unknown',
        });
        registerTranscriptSink({
          sessionId: id,
          transcriptsDir: ctx.transcriptsDir,
          branch: meta.branch ?? 'unknown',
        });
      } catch (e) {
        logEvent(id, 'context.resume_setup_failed', { message: (e as Error).message });
      }
    }

    try {
      db().prepare(
        'UPDATE sessions SET status = ?, updated_at = ?, cmd = ?, closed_at = NULL WHERE id = ?'
      ).run('spawning', meta.updatedAt, JSON.stringify(cmd), id);
    } catch { /* ignore */ }

    this.wirePty(id);
    this.emit('status', { id, status: 'spawning' });
    return { ...meta };
  }

  /**
   * On boot: scan the DB for sessions whose worktree still exists on disk
   * and register them as dormant (in-memory but no live PTY). They show up
   * in list() so the UI can offer them in the resume picker.
   */
  restoreDormant(): { restored: number; skipped: number } {
    let restored = 0;
    let skipped = 0;
    let rows: Array<{
      id: string; copilot_session_id: string | null; branch: string | null;
      worktree_path: string | null; repo_path: string | null; cwd: string;
      cmd: string; status: string; created_at: number; updated_at: number;
      title: string | null;
    }> = [];
    try {
      rows = db().prepare(
        `SELECT id, copilot_session_id, branch, worktree_path, repo_path, cwd, cmd,
                status, created_at, updated_at, title
         FROM sessions
         WHERE worktree_path IS NOT NULL
         ORDER BY updated_at DESC
         LIMIT 200`
      ).all() as typeof rows;
    } catch (e) {
      console.warn('[sessions] restoreDormant query failed:', (e as Error).message);
      return { restored, skipped };
    }

    for (const row of rows) {
      if (this.sessions.has(row.id)) { skipped++; continue; }
      if (!row.worktree_path || !existsSync(row.worktree_path)) { skipped++; continue; }
      let cmd: string[];
      try { cmd = JSON.parse(row.cmd); } catch { cmd = [DEFAULTS.copilotBin]; }
      const meta: SessionMeta = {
        id: row.id,
        cwd: row.cwd,
        cmd,
        status: 'exited',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        copilotSessionId: row.copilot_session_id,
        title: row.title ?? row.branch ?? null,
        repoPath: row.repo_path,
        worktreePath: row.worktree_path,
        branch: row.branch,
        dormant: true,
      };
      this.sessions.set(row.id, {
        meta,
        pty: null,
        replay: new RingBuffer(REPLAY_MAX),
        subscribers: new Set(),
        copilotSessionDir: null,
        resolveTimer: null,
        tailFd: null,
        tailOffset: 0,
        tailTimer: null,
        toolStartTs: new Map(),
      });
      restored++;
    }
    // Best-effort: any DB row that says spawning/idle/working but isn't in our
    // map and has no worktree → mark exited (the previous server died).
    try {
      db().prepare(
        `UPDATE sessions SET status = 'exited', closed_at = COALESCE(closed_at, ?)
         WHERE status NOT IN ('exited') AND id NOT IN (${[...this.sessions.keys()].map(() => '?').join(',') || "''"})`
      ).run(Date.now(), ...this.sessions.keys());
    } catch { /* ignore */ }
    return { restored, skipped };
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
    if (!s.pty) throw new Error(`session is dormant: ${id} — resume first`);
    s.pty.write(data.toString('utf8'));
    if (s.meta.status === 'needs-input') this.setStatus(id, 'working');
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (!s || !s.pty) return;
    try { s.pty.resize(Math.max(2, cols), Math.max(2, rows)); } catch { /* ignore */ }
  }

  close(id: string): void {
    const s = this.sessions.get(id);
    if (!s || !s.pty) return;
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

  // ─── JSONL sidecar ────────────────────────────────────────────────────────
  // The Copilot CLI writes typed events to
  //   ~/.copilot/session-state/<copilotSessionId>/events.jsonl
  // We discover <copilotSessionId> by scanning for an `inuse.<pid>.lock` file
  // (where <pid> is our spawned PTY child), then tail the JSONL to derive
  // accurate status transitions (working / idle / needs-input / error). The
  // PTY itself remains the user-facing render — the sidecar only drives state.

  private startResolver(s: Internal): void {
    const pid = s.pty?.pid;
    if (!pid) return;
    const id = s.meta.id;
    let elapsed = 0;
    const intervalMs = 100;
    const maxMs = 30_000;
    s.resolveTimer = setInterval(() => {
      if (!s.pty) { this.stopResolver(s); return; }
      elapsed += intervalMs;
      const dir = findSessionDirByPid(pid);
      if (dir) {
        s.copilotSessionDir = dir;
        const sid = dir.split('/').pop()!;
        s.meta.copilotSessionId = sid;
        try {
          db().prepare('UPDATE sessions SET copilot_session_id = ? WHERE id = ?').run(sid, id);
        } catch { /* ignore */ }
        logEvent(id, 'session.copilot_id', { copilotSessionId: sid });
        this.stopResolver(s);
        this.startTail(s);
      } else if (elapsed >= maxMs) {
        logEvent(id, 'session.sidecar_unresolved', { pid });
        this.stopResolver(s);
      }
    }, intervalMs);
  }

  private stopResolver(s: Internal): void {
    if (s.resolveTimer) { clearInterval(s.resolveTimer); s.resolveTimer = null; }
  }

  private startTail(s: Internal): void {
    if (!s.copilotSessionDir) return;
    const events = join(s.copilotSessionDir, 'events.jsonl');
    const openOnce = (): boolean => {
      if (!existsSync(events)) return false;
      try {
        s.tailFd = openSync(events, 'r');
        s.tailOffset = 0;
        s.tailTimer = setInterval(() => this.drainTail(s), 200);
        return true;
      } catch {
        return false;
      }
    };
    if (openOnce()) return;
    // events.jsonl may not exist on the first poll — keep trying briefly.
    const waitTimer = setInterval(() => {
      if (openOnce()) clearInterval(waitTimer);
    }, 100);
    setTimeout(() => clearInterval(waitTimer), 10_000);
  }

  private stopTail(s: Internal): void {
    if (s.tailTimer) { clearInterval(s.tailTimer); s.tailTimer = null; }
    if (s.tailFd !== null) {
      try { closeSync(s.tailFd); } catch { /* ignore */ }
      s.tailFd = null;
    }
  }

  private drainTail(s: Internal): void {
    if (s.tailFd === null || !s.copilotSessionDir) return;
    const events = join(s.copilotSessionDir, 'events.jsonl');
    let size: number;
    try { size = statSync(events).size; } catch { return; }
    if (size <= s.tailOffset) return;
    const want = size - s.tailOffset;
    const buf = Buffer.alloc(want);
    try {
      readSync(s.tailFd, buf, 0, want, s.tailOffset);
    } catch { return; }
    s.tailOffset = size;
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    const lastIsEmpty = lines[lines.length - 1] === '';
    if (!lastIsEmpty && lines.length > 0) {
      // Final entry is a partial line — rewind so we re-read it next poll.
      const partialBytes = Buffer.byteLength(lines[lines.length - 1], 'utf8');
      s.tailOffset -= partialBytes;
    }
    const completeLines = lines.slice(0, -1);
    for (const l of completeLines) {
      if (!l.trim()) continue;
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(l); } catch { continue; }
      this.onCliEvent(s, ev);
    }
  }

  private onCliEvent(s: Internal, ev: Record<string, unknown>): void {
    const id = s.meta.id;
    const type = String(ev.type ?? '');
    const data = (ev.data && typeof ev.data === 'object' ? ev.data : {}) as Record<string, unknown>;
    logEvent(id, `cli.${type}`, data);

    switch (type) {
      case 'session.start':
      case 'session.resume':
        this.setStatus(id, 'idle');
        break;
      case 'assistant.turn_start':
        this.setStatus(id, 'working');
        break;
      case 'assistant.turn_end':
      case 'session.idle':
      case 'session.task_complete':
        // Don't mask a needs-input that arrived during the turn (permission
        // requests can fire mid-turn and we want them to win until resolved).
        if (s.meta.status !== 'needs-input') this.setStatus(id, 'idle');
        break;
      case 'tool.execution_start': {
        const callId = String(data.toolCallId ?? data.id ?? '');
        const name = String(data.toolName ?? data.name ?? '');
        if (callId) s.toolStartTs.set(callId, { name, ts: Date.now() });
        // ask_user is the agent's interactive picker tool — it blocks the turn
        // waiting on user input but doesn't emit permission.requested. Treat it
        // the same way: flip to needs-input so chime + OS notification fire.
        if (INTERACTIVE_TOOLS.has(name)) this.setStatus(id, 'needs-input');
        break;
      }
      case 'tool.execution_complete': {
        const callId = String(data.toolCallId ?? data.id ?? '');
        const entry = s.toolStartTs.get(callId);
        s.toolStartTs.delete(callId);
        // If an interactive tool just resolved while we're still showing
        // needs-input (e.g. user clicked an option in the PTY), flip back to
        // working so the next turn boundary can settle normally.
        if (entry && INTERACTIVE_TOOLS.has(entry.name) && s.meta.status === 'needs-input') {
          this.setStatus(id, 'working');
        }
        break;
      }
      case 'permission.requested':
        this.setStatus(id, 'needs-input');
        break;
      case 'permission.completed':
        // Status will normalise on the next turn boundary (turn_end).
        if (s.meta.status === 'needs-input') this.setStatus(id, 'working');
        break;
      case 'abort':
        this.setStatus(id, 'idle');
        break;
      case 'session.error':
        this.setStatus(id, 'error');
        break;
      case 'session.shutdown':
        // CLI cleanup; the PTY exit handler owns the final 'exited' status.
        break;
      default:
        // Unknown CLI event — already mirrored to events.jsonl on disk via logEvent.
        break;
    }
  }


  /**
   * Kill all live PTYs and wait for their onExit handlers (which run
   * saveWorktreeWork → may commit + push) to complete, up to a grace window.
   * Resolves either when every pending handler is done, or when the grace
   * timeout hits — whichever comes first.
   */
  async shutdownAll(graceMs: number = LIMITS.SHUTDOWN_GRACE_MS): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const [id, s] of this.sessions.entries()) {
      if (!s.pty) continue;
      const p = this.exitPromises.get(id);
      if (p) pending.push(p);
      try { s.pty.kill(); } catch { /* ignore */ }
    }
    if (pending.length === 0) return;
    await Promise.race([
      Promise.all(pending).then(() => undefined),
      new Promise<void>((r) => setTimeout(r, graceMs)),
    ]);
  }
}

export const sessionManager = new SessionManager();

function findSessionDirByPid(pid: number): string | null {
  if (!existsSync(SESSION_STATE_ROOT)) return null;
  let names: string[];
  try { names = readdirSync(SESSION_STATE_ROOT); } catch { return null; }
  for (const name of names) {
    const dir = join(SESSION_STATE_ROOT, name);
    const lock = join(dir, `inuse.${pid}.lock`);
    if (existsSync(lock)) return dir;
  }
  return null;
}
