// Per-session alert dispatcher. Solves the "two chimes per event / sometimes
// zero chimes / spurious agent-finished on spawn" cluster of bugs by:
//
//   1. Owning the (prev,status,cause)→kind decision in ONE place, with
//      explicit rules — most importantly, `spawning → idle` is NOT
//      "agent finished".
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

import type { SessionStatus, InputCause } from '../shared/protocol.js';
import { type AlertKind, priorityOf } from '../shared/alerts.js';

export type { AlertKind };

/**
 * Map a status transition (+ optional InputCause) to an alert kind, or `null`.
 *
 * Rules:
 *  - Any transition INTO `needs-input` → either the cause-specific kind
 *    (ask-user / permission / elicitation) if known, else generic needs-input.
 *  - Any transition INTO `error` → error.
 *  - `working → idle` → agent-finished.
 *  - `spawning → idle` → NO alert (the agent is just done starting up; a
 *    separate session-spawned chime is fired by the lifecycle path).
 *  - Same-state transitions → no alert.
 */
export function alertKindFor(prev: SessionStatus, next: SessionStatus, cause?: InputCause): AlertKind | null {
  if (prev === next) return null;
  if (next === 'needs-input') {
    if (cause === 'ask-user') return 'ask-user';
    if (cause === 'permission') return 'permission';
    if (cause === 'elicitation') return 'elicitation';
    return 'needs-input';
  }
  if (next === 'error') return 'error';
  if (next === 'idle' && prev === 'working') return 'agent-finished';
  return null;
}

// Higher number wins inside the settle window. Priorities live in the
// shared alert registry (src/shared/alerts.ts) — change them there and
// every consumer follows. We read through priorityOf() instead of caching
// a local map so a future picker that lets the user re-prioritise kinds
// at runtime can flow through without changing the dispatcher.

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
   *
   * Special case: any transition INTO `working` cancels a pending
   * `agent-finished`. The agent obviously isn't finished — it just opened
   * another turn (e.g. to process a tool result). The server-side
   * `suppressNextTurnEndIdle` flag should prevent the working→idle flap
   * from ever reaching us, but if it does (older clients, mis-classified
   * tool, etc.) this is the belt-and-braces backup.
   */
  onTransition(id: string, prev: SessionStatus, next: SessionStatus, cause?: InputCause): void {
    if (next === 'working') {
      const pending = this.pending.get(id);
      if (pending && pending.kind === 'agent-finished') this.cancel(id);
    }
    const kind = alertKindFor(prev, next, cause);
    if (!kind) return;
    this.enqueue(id, kind);
  }

  /**
   * Out-of-band alert for events that don't correspond to a status transition
   * (e.g., a single tool call failed but the session keeps running). Goes
   * through the same coalescing + priority logic so we still avoid double
   * chimes when a tool failure and a status transition collide.
   */
  signal(id: string, kind: AlertKind): void {
    this.enqueue(id, kind);
  }

  private enqueue(id: string, kind: AlertKind): void {
    const existing = this.pending.get(id);
    let winner = kind;
    if (existing) {
      this.clearTimer(existing.timer);
      // Keep whichever kind is higher priority — needs-input arriving after
      // a queued agent-finished should upgrade the alert, but a late
      // agent-finished must NOT downgrade a queued needs-input.
      winner = priorityOf(kind) >= priorityOf(existing.kind) ? kind : existing.kind;
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
