export const PROTOCOL_VERSION = 1;

export type SessionStatus = 'spawning' | 'idle' | 'working' | 'needs-input' | 'error' | 'exited';

/**
 * When a session transitions INTO `needs-input`, this further classifies why,
 * so the dashboard can play the right chime (the user picked distinct sounds
 * for ask_user vs permission gates vs elicitation prompts).
 */
export type InputCause = 'ask-user' | 'permission' | 'elicitation';

export interface SessionMeta {
  id: string;
  copilotSessionId?: string | null;
  cwd: string;
  cmd: string[];
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  title?: string | null;
  repoPath?: string | null;
  worktreePath?: string | null;
  branch?: string | null;
  /** True when restored from DB on boot with no live PTY. Resumable via session.resume. */
  dormant?: boolean;
  /** Optional running stats. Filled from events.jsonl while the session
   *  is live; not persisted, so dormant sessions show zeros until they
   *  emit their first event on resume. Used by the dashboard footer. */
  stats?: SessionStats;
}

/** Cheap running totals for the active-session footer indicator.
 *  We deliberately track only fields the CLI's events.jsonl actually
 *  emits — Copilot CLI publishes `outputTokens` per assistant message
 *  but no input/context tokens, so we surface only what we can verify. */
export interface SessionStats {
  /** Most recently announced model id (e.g. 'gpt-5.2', 'claude-opus-4.7'). */
  model: string | null;
  /** Number of assistant turns the agent has completed this session. */
  turns: number;
  /** Cumulative output tokens across all assistant messages this session. */
  outputTokens: number;
  /** Cumulative tool invocations this session. */
  toolCalls: number;
}

export type ServerMsg =
  | { t: 'hello'; protocolVersion: number }
  | { t: 'session.list'; sessions: SessionMeta[] }
  | { t: 'session.created'; session: SessionMeta }
  | { t: 'session.status'; id: string; status: SessionStatus; cause?: InputCause }
  | { t: 'session.stats'; id: string; stats: SessionStats }
  | { t: 'session.tool_failed'; id: string; tool?: string }
  | { t: 'pty.data'; id: string; data: string }
  | { t: 'pty.exit'; id: string; code: number | null; signal: string | null }
  | { t: 'error'; id?: string; message: string };

export type ClientMsg =
  | { t: 'session.new'; cwd?: string; cmd?: string[]; repoPath?: string; branchName?: string; baseBranch?: string }
  | { t: 'session.attach'; id: string }
  | { t: 'session.close'; id: string }
  | { t: 'session.resume'; id: string }
  | { t: 'pty.input'; id: string; data: string }
  | { t: 'pty.resize'; id: string; cols: number; rows: number };
