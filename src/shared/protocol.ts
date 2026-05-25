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
}

export type ServerMsg =
  | { t: 'hello'; protocolVersion: number }
  | { t: 'session.list'; sessions: SessionMeta[] }
  | { t: 'session.created'; session: SessionMeta }
  | { t: 'session.status'; id: string; status: SessionStatus; cause?: InputCause }
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
