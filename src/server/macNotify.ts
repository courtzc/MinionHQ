/**
 * Native macOS notifications.
 *
 * Browser Notification API entries don't always surface in Notification Center
 * the way native apps do, and they get rate-limited / coalesced aggressively
 * by Chromium. To get a proper "real" macOS toast we shell out from the server.
 *
 * Strategy (in priority order):
 *   1. `terminal-notifier` if installed — best UX (supports -execute for
 *      click-to-focus, custom group/sender, sounds).
 *   2. `osascript -e 'display notification ...'` — zero-dependency fallback.
 *      Always works on macOS but has no click handler.
 *
 * On non-darwin platforms this is a no-op.
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const execFileP = promisify(execFile);

export type MacNotifyKind =
  | 'needs-input'
  | 'agent-finished'
  | 'error'
  | 'ask-user'
  | 'permission'
  | 'elicitation'
  | 'session-spawned'
  | 'session-resumed'
  | 'session-stopped'
  | 'tool-failed';

const IS_DARWIN = process.platform === 'darwin';

/**
 * Absolute path to the minion icon PNG used as the notification's app icon.
 * Computed once at module load — terminal-notifier needs a real on-disk
 * path (not a URL). Tries `public/icon.png` first (post-build) and falls
 * back to `src/web/icon.png` (dev mode with no build artifacts).
 */
const ICON_PATH: string | null = (() => {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const projectRoot = resolve(__dirname, '..', '..');
    for (const rel of ['public/icon.png', 'src/web/icon.png']) {
      const candidate = join(projectRoot, rel);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  } catch {
    return null;
  }
})();

// Detect terminal-notifier once at boot. Cached for the lifetime of the
// process — restarting MinionHQ picks up newly-installed binaries.
let terminalNotifierPath: string | null = null;
let detected = false;

async function detect(): Promise<void> {
  if (detected) return;
  detected = true;
  if (!IS_DARWIN) return;
  try {
    const { stdout } = await execFileP('which', ['terminal-notifier']);
    const p = stdout.trim();
    if (p) terminalNotifierPath = p;
  } catch {
    terminalNotifierPath = null;
  }
}

/**
 * macOS system sound names (without extension). Mirrors the user-picked
 * chime mapping in src/web/chimes.ts so the OS toast plays the same sound
 * the browser plays via Web Audio. Both `chimes` and `notifications`
 * toggles are independent in the UI — when both are on, the user hears
 * the same sound once from the browser and once from Notification Center.
 */
function soundFor(kind: MacNotifyKind): string {
  switch (kind) {
    case 'needs-input':     return 'Hero';
    case 'agent-finished':  return 'Submarine';
    case 'error':           return 'Sosumi';
    case 'ask-user':        return 'Hero';
    case 'permission':      return 'Purr';
    case 'elicitation':     return 'Funk';
    case 'session-spawned': return 'Blow';
    case 'session-resumed': return 'Blow';
    case 'session-stopped': return 'Bottle';
    case 'tool-failed':     return 'Ping';
  }
}

function titleFor(kind: MacNotifyKind, sessionLabel: string | null): string {
  const tag = sessionLabel ? ` — ${sessionLabel}` : '';
  switch (kind) {
    case 'needs-input':     return `MinionHQ: needs input${tag}`;
    case 'ask-user':        return `MinionHQ: agent has a question${tag}`;
    case 'permission':      return `MinionHQ: permission required${tag}`;
    case 'elicitation':     return `MinionHQ: input requested${tag}`;
    case 'agent-finished':  return `MinionHQ: agent finished${tag}`;
    case 'error':           return `MinionHQ: error${tag}`;
    case 'tool-failed':     return `MinionHQ: tool failed${tag}`;
    case 'session-spawned': return `MinionHQ: session started${tag}`;
    case 'session-resumed': return `MinionHQ: session resumed${tag}`;
    case 'session-stopped': return `MinionHQ: session stopped${tag}`;
  }
}

function escapeAppleScript(s: string): string {
  // AppleScript string literal: backslash and double-quote need escaping.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export interface NotifyOpts {
  kind: MacNotifyKind;
  sessionLabel: string | null;
  body?: string;
  /** URL to open on click — only honored when terminal-notifier is present. */
  openUrl?: string;
}

/**
 * Fire a native macOS notification. Returns the transport used so callers can
 * report it / fall back to browser notifications on non-mac.
 */
export async function notifyMac(opts: NotifyOpts): Promise<'terminal-notifier' | 'osascript' | 'noop'> {
  if (!IS_DARWIN) return 'noop';
  await detect();

  const title = titleFor(opts.kind, opts.sessionLabel);
  const body = opts.body ?? '';
  const sound = soundFor(opts.kind);

  if (terminalNotifierPath) {
    const args = [
      '-title', title,
      '-message', body || ' ',
      '-sound', sound,
      '-group', `minionhq-${opts.kind}`,
      '-sender', 'com.apple.Safari',
    ];
    if (ICON_PATH) {
      // -appIcon swaps the (Safari) sender icon for our minion. terminal-notifier
      // also accepts file:// URLs, but plain absolute paths work too.
      args.push('-appIcon', ICON_PATH);
    }
    if (opts.openUrl) {
      args.push('-open', opts.openUrl);
    }
    // Fire-and-forget. Don't block the HTTP response on notification delivery.
    const p = spawn(terminalNotifierPath, args, { detached: true, stdio: 'ignore' });
    p.unref();
    p.on('error', (err) => { console.warn('[macNotify] terminal-notifier failed:', err.message); });
    return 'terminal-notifier';
  }

  // osascript fallback. Note: no click handler available.
  const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}" sound name "${escapeAppleScript(sound)}"`;
  const p = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
  p.unref();
  p.on('error', (err) => { console.warn('[macNotify] osascript failed:', err.message); });
  return 'osascript';
}

export function isMacNotifySupported(): boolean {
  return IS_DARWIN;
}
