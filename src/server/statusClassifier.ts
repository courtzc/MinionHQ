import type { SessionStatus } from '../shared/protocol.js';

// Heuristic classifier that reads PTY chunks and decides whether the agent is
// waiting for input, working, or idle. Conservative — defaults to keeping the
// current status when nothing clear is detected.

const STRIP_ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b[<=>]|\x1b\][^\\]*\\/g;

function stripAnsi(s: string): string {
  return s.replace(STRIP_ANSI_RE, '');
}

const NEEDS_INPUT_PATTERNS: RegExp[] = [
  /\[y\/n\]/i,
  /\(y\/n\)/i,
  /\(yes\/no\)/i,
  /\bpress\s+enter\b/i,
  /\bcontinue\?/i,
  /\bapprove\?/i,
  /\bproceed\?/i,
  /\benter\s+to\s+continue\b/i,
  /\bdo you want to\b/i,
];

// A bare ">"/"❯" prompt on its own line means the agent finished a turn and
// is ready for the next message — that's "idle" (resolved chime), not
// "needs-input" (unresolved). Keeping these separate fixes the "random chime"
// problem where every turn ended with an unresolved cadence.
const IDLE_PROMPT_PATTERNS: RegExp[] = [
  /^\s*[>❯]\s*$/m,
];

const WORKING_PATTERNS: RegExp[] = [
  /\bthinking\b/i,
  /\bworking\b/i,
  /\branalyzing\b/i,
  /\bsearching\b/i,
  /\brunning\b/i,
  /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,                  // braille spinner glyphs
];

const ERROR_PATTERNS: RegExp[] = [
  /\berror:/i,
  /\bfailed:/i,
  /\bexception\b/i,
  /\btraceback\b/i,
];

export function classify(chunk: Buffer, currentStatus: SessionStatus): SessionStatus | null {
  const text = stripAnsi(chunk.toString('utf8'));
  if (!text.trim()) return null;

  for (const p of ERROR_PATTERNS) if (p.test(text)) return 'error';
  for (const p of NEEDS_INPUT_PATTERNS) if (p.test(text)) return 'needs-input';
  for (const p of WORKING_PATTERNS) if (p.test(text)) return 'working';

  // A bare ">"/"❯" prompt = agent finished its turn and is ready for the next
  // message. Treat that as "idle" rather than "needs-input" so the user hears
  // the resolved chime (1-3-5-1) on turn completion and reserves the unresolved
  // chime for actual interactive prompts (y/n, "approve?", etc.).
  for (const p of IDLE_PROMPT_PATTERNS) if (p.test(text)) return 'idle';

  // If we were "working" and a quiet trailing block arrives, drop to idle.
  // Detect "idle" by trailing blank line + reasonable amount of content.
  if (currentStatus === 'working' && /\n\s*\n\s*$/.test(text)) return 'idle';

  return null;
}
