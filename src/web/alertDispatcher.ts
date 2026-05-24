// Per-session alert dispatcher. Solves the "two chimes per event / sometimes
// zero chimes / spurious agent-finished on spawn" cluster of bugs by:
//
//   1. Owning the (prev,status)→kind decision in ONE place, with explicit
//      rules — most importantly, `spawning → idle` is NOT "agent finished".
//   2. Coalescing rapid transitions inside a settle window (default 500ms).
//      The agent often emits `working → idle → needs-input` within ~150ms;
//      we want ONE chime + ONE OS notification for that whole burst, of the
//      highest-priority kind that landed in the window.
//   3. Keeping the firing path side-effect-free (the dispatcher only calls
//      the injected fire() callback) so it's testable in node with fake
//      timers and never accidentally double-fires.
//
// The dispatcher does NOT decide whether chimes/notifications are enabled,
// or whether a session has been popped out — that gating happens in the
// caller. Keep this module pure-ish and predictable.

import type { SessionStatus } from '../shared/protocol.js';

export type AlertKind = 'needs-input' | 'agent-finished' | 'error';

/**
 * Map a status transition to an alert kind, or `null` if no alert.
 *
 * Rules:
 *  - Any transition INTO `needs-input` (from anything except needs-input) →ungroup needs-input.
 *  - Any transition INTO `error` (from anything except error) → error.
 *  - `working → idle` → agent-finished (the agent completed a turn).
 *  - `spawning → idle` → NO alert. The agent is just done starting up.
 *  - Same-state transitions → no alert.
 *  - Everything else (idle → working, working → needs-input handled above,
 *    error → idle, exited → anything) → no alert.
 */
export function alertKindFor(prev: SessionStatus, next: SessionStatus): AlertKind | null {
  if (prev === next) return null;
  if (next === 'needs-input') return 'needs-input';
  if (next === 'error') return 'error';
  if (next === 'idle' && prev === 'working') return 'agent-finished';
  return null;
}

// Higher number wins inside the settle window.
const PRIORITY: Record<AlertKind, number> = {
  error: 3,
  'needs-input': 2,
  'agent-finished': 1,
};

export interface DispatcherOpts {
  /** How long to wait after the LAST transition before firing. */
  windowMs?: number;
  /** Called once per settled alert. Side effects (chime, notify) live here. */
  fire: (id: string, kind: AlertKind) => void;
  /** Timer fns — injected so tests can use fake timers. */
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

interface Pending {
  kind: AlertKind;
  timer: unknown;
}

export class AlertDispatcher {
  private pending = new Map<string, Pending>();
  private readonly windowMs: number;
  private readonly fire: (id: string, kind: AlertKind) => void;
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  constructor(opts: DispatcherOpts) {
    this.windowMs = opts.windowMs ?? 500;
    this.fire = opts.fire;
    this.setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /**
   * Notify the dispatcher of a status transition for a session. The
   * dispatcher schedules a fire after the settle window, replacing any
   * pending alert for the same session with the higher-priority kind.
   */
  onTransition(id: string, prev: SessionStatus, next: SessionStatus): void {
    const kind = alertKindFor(prev, next);
    if (!kind) return;

    const existing = this.pending.get(id);
    let winner = kind;
    if (existing) {
      this.clearTimer(existing.timer);
      // Keep whichever kind is higher priority — needs-input arriving after
      // a queued agent-finished should upgrade the alert, but a late
      // agent-finished must NOT downgrade a queued needs-input.
      winner = PRIORITY[kind] >= PRIORITY[existing.kind] ? kind : existing.kind;
    }

    const timer = this.setTimer(() => {
      const p = this.pending.get(id);
      this.pending.delete(id);
      if (p) this.fire(id, p.kind);
    }, this.windowMs);

    this.pending.set(id, { kind: winner, timer });
  }

  /** Cancel any pending alert for a session (e.g., on close / pop-out). */
  cancel(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.clearTimer(p.timer);
    this.pending.delete(id);
  }

  /** For tests / shutdown. */
  cancelAll(): void {
    for (const [id] of this.pending) this.cancel(id);
  }

  /** For tests — inspect what would fire if the window expired now. */
  peek(id: string): AlertKind | null {
    return this.pending.get(id)?.kind ?? null;
  }
}
