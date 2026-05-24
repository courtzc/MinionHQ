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

const execFileP = promisify(execFile);

export type MacNotifyKind = 'needs-input' | 'done' | 'error';

const IS_DARWIN = process.platform === 'darwin';

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
 * Sound names are macOS system sounds in /System/Library/Sounds. We pick
 * distinct ones per kind so the audio cue matches the chime kind in-browser.
 */
function soundFor(kind: MacNotifyKind): string {
  switch (kind) {
    case 'needs-input': return 'Tink';
    case 'done':        return 'Glass';
    case 'error':       return 'Basso';
  }
}

function titleFor(kind: MacNotifyKind, sessionLabel: string | null): string {
  const tag = sessionLabel ? ` — ${sessionLabel}` : '';
  switch (kind) {
    case 'needs-input': return `MinionHQ: needs input${tag}`;
    case 'done':        return `MinionHQ: done${tag}`;
    case 'error':       return `MinionHQ: error${tag}`;
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
