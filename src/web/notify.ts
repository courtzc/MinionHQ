export type NotifyKind = 'needs-input' | 'done' | 'error';

let permissionAsked = false;

export function ensurePermission(): void {
  if (permissionAsked) return;
  permissionAsked = true;
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'default') {
    Notification.requestPermission().catch(() => { /* ignore */ });
  }
}

function title(kind: NotifyKind, sessionTitle?: string | null): string {
  const tag = sessionTitle ? ` — ${sessionTitle}` : '';
  switch (kind) {
    case 'needs-input': return `copilot-multi: needs input${tag}`;
    case 'done':        return `copilot-multi: done${tag}`;
    case 'error':       return `copilot-multi: error${tag}`;
  }
}

export function notify(kind: NotifyKind, sessionTitle?: string | null, body?: string): void {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  // Only notify if the document isn't already in foreground
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  try {
    const n = new Notification(title(kind, sessionTitle), {
      body: body ?? '',
      tag: `copilot-multi-${kind}`,
      silent: true,
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (e) {
    console.warn('[notify] failed:', e);
  }
}
