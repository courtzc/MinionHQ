import type { SessionStatus } from '../shared/protocol.js';

// Heuristic classifier that reads PTY chunks and decides whether the agent is
// waiting for input, working, or idle. Conservative — defaults to keeping the
// current status when nothing clear is detected.

const STRIP_ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b[<=>]|\x1b\][^\\]*\\/g;

function stripAnsi(s: string): string {
  return s.replace(STRIP_ANSI_RE, '');
}

const NEEDS_INPUT_PATTERNS: RegExp[] = [
  // Explicit y/n style prompts.
  /\[y\/n\]/i,
  /\(y\/n\)/i,
  /\[Y\/n\]/,
  /\[y\/N\]/,
  /\(yes\/no\)/i,

  // Generic confirmation language.
  /\bpress\s+enter\b/i,
  /\benter\s+to\s+continue\b/i,
  /\bcontinue\?/i,
  /\bapprove\?/i,
  /\bproceed\?/i,
  /\bconfirm\?/i,
  /\bdo you want to\b/i,
  /\bawaiting\s+(?:your\s+)?(?:input|response|reply)\b/i,
  /\bwaiting\s+for\s+(?:your\s+)?(?:input|response|reply)\b/i,

  // Copilot CLI / Ink-widget signatures. Modern Copilot uses an Ink form
  // with a leading "? " glyph for prompts, an arrow-key chooser like
  // "❯ Yes" / "› No", or hint copy like "(use arrow keys)".
  /^\s*\?\s+.+\?/m,                          // "? Run this command?"
  /^\s*[❯›>]\s+(?:Yes|No)\b/im,              // "❯ Yes" / "› No" / "> Yes"
  /\(use\s+arrow\s+keys?\)/i,
  /\bselect\s+an?\s+option\b/i,
  /\benter\s+to\s+(?:submit|confirm|select)\b/i,

  // Last-resort: a chunk whose final non-blank line ends in a "?". This is
  // intentionally checked AFTER the more specific patterns so we don't
  // misclassify chatter mid-stream; combined with the "last line" anchor it
  // is a strong signal the agent just asked a question and stopped writing.
  /\?\s*\n?\s*$/,
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
