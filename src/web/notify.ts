export type NotifyKind = 'needs-input' | 'agent-finished' | 'error';

let permissionAsked = false;
let macSupported: boolean | null = null;

// Cache server capability — checked once per page load.
async function checkMacSupport(): Promise<boolean> {
  if (macSupported !== null) return macSupported;
  try {
    const res = await fetch('/api/notify/capabilities');
    const data = (await res.json()) as { ok: boolean; mac?: boolean };
    macSupported = !!data.mac;
  } catch {
    macSupported = false;
  }
  return macSupported;
}

export function ensurePermission(): void {
  // Kick off the mac-capability probe so the first notify() call doesn't
  // wait on it. Independent of browser-Notification permission.
  void checkMacSupport();
  if (permissionAsked) return;
  permissionAsked = true;
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'default') {
    Notification.requestPermission().catch(() => { /* ignore */ });
  }
}

function browserTitle(kind: NotifyKind, sessionTitle?: string | null): string {
  const tag = sessionTitle ? ` — ${sessionTitle}` : '';
  switch (kind) {
    case 'needs-input':    return `MinionHQ: needs input${tag}`;
    case 'agent-finished': return `MinionHQ: agent finished${tag}`;
    case 'error':          return `MinionHQ: error${tag}`;
  }
}

function browserNotify(kind: NotifyKind, sessionTitle?: string | null, body?: string): void {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  // No visibility/focus gate: the user may have walked away from a focused
  // window — OS-level toasts should always fire so they can hear/see them
  // from across the room or on another desktop.
  try {
    const n = new Notification(browserTitle(kind, sessionTitle), {
      body: body ?? '',
      tag: `minionhq-${kind}`,
      silent: true,
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (e) {
    console.warn('[notify] browser path failed:', e);
  }
}

async function macNotify(kind: NotifyKind, sessionTitle?: string | null, body?: string): Promise<void> {
  try {
    await fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind,
        sessionLabel: sessionTitle ?? null,
        body: body ?? '',
        openUrl: location.origin + '/',
      }),
    });
  } catch (e) {
    console.warn('[notify] mac path failed, falling back:', e);
    browserNotify(kind, sessionTitle, body);
  }
}

/**
 * Fire a notification. Prefers native macOS notifications (server-side
 * osascript/terminal-notifier) and falls back to the browser Notification API
 * on other platforms.
 *
 * No focus/visibility gate — the user explicitly wants OS notifications even
 * when they're staring at the window (they might walk away mid-turn and need
 * to know when the agent finishes from across the room).
 */
export function notify(kind: NotifyKind, sessionTitle?: string | null, body?: string): void {
  void (async () => {
    const mac = await checkMacSupport();
    if (mac) {
      await macNotify(kind, sessionTitle, body);
    } else {
      browserNotify(kind, sessionTitle, body);
    }
  })();
}
