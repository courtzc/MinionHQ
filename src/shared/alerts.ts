/**
 * Single source of truth for "alert kinds" — the logical events that can
 * fire a chime, an OS toast, or both. Adding a new kind means adding ONE
 * entry to {@link ALERTS} below; every consumer derives titles, sounds,
 * priorities, and picker descriptions from this table.
 *
 * Consumers:
 *  - {@link ../web/alertDispatcher.ts} reads `priority` for in-window
 *    coalescing.
 *  - {@link ../web/chimes.ts} reads `defaultSound` as the fallback chime
 *    when the user hasn't overridden the picker mapping.
 *  - {@link ../web/notify.ts} and {@link ../server/macNotify.ts} both
 *    call {@link browserToastTitle} / {@link defaultSoundOf} for their
 *    notification strings.
 *  - The chimes picker (`public/chimes.html`) fetches the catalogue from
 *    `/api/alerts/catalog` (served from this module) so it renders one
 *    row per kind without a parallel hand-maintained list.
 */

/**
 * Every event class that can fire a chime or OS toast. Listed in roughly
 * the order they're presented in the picker (active > sub > lifecycle >
 * aspirational); ordering here drives the picker layout.
 */
export type AlertKind =
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

/**
 * Picker grouping. Purely cosmetic for the chimes.html UI; the dispatcher
 * doesn't care about tiers.
 *  - `active`       — the agent is interrupting you NOW (most important).
 *  - `sub`          — a more specific sub-classification of `needs-input`.
 *  - `lifecycle`    — purely informational session-state events.
 *  - `aspirational` — fires today but represents work we may expand later.
 */
export type AlertTier = 'active' | 'sub' | 'lifecycle' | 'aspirational';

export interface AlertSpec {
  /** Short identifier shown next to the picker dropdown. Usually equal to the kind. */
  displayName: string;
  /** One-line description shown in the picker — tells the user when this fires. */
  description: string;
  /** macOS system sound name (no extension) used as the default chime mapping. */
  defaultSound: string;
  /** Verb fragment inserted into the OS toast: `MinionHQ: <toastTitle>`. */
  toastTitle: string;
  /** Higher number = more important inside the dispatcher's settle window. */
  priority: number;
  /** Picker grouping (display-only). */
  tier: AlertTier;
}

/**
 * The registry. Add new kinds here and TypeScript will enforce coverage
 * in every consumer that uses `Record<AlertKind, …>`.
 */
export const ALERTS: Record<AlertKind, AlertSpec> = {
  'needs-input': {
    displayName: 'needs-input',
    description: 'Session is waiting on you (any input/permission/elicitation).',
    defaultSound: 'Hero',
    toastTitle: 'needs input',
    priority: 3,
    tier: 'active',
  },
  'agent-finished': {
    displayName: 'agent-finished',
    description: 'Agent finished a turn and is idle.',
    defaultSound: 'Submarine',
    toastTitle: 'agent finished',
    priority: 1,
    tier: 'active',
  },
  'error': {
    displayName: 'error',
    description: 'Session entered error state.',
    defaultSound: 'Sosumi',
    toastTitle: 'error',
    priority: 5,
    tier: 'active',
  },
  'ask-user': {
    displayName: 'ask_user',
    description: 'Agent specifically asked a question (subset of needs-input).',
    defaultSound: 'Hero',
    toastTitle: 'agent has a question',
    priority: 3,
    tier: 'sub',
  },
  'permission': {
    displayName: 'permission_request',
    description: 'Agent wants to run a tool that needs approval.',
    defaultSound: 'Purr',
    toastTitle: 'permission required',
    priority: 3,
    tier: 'sub',
  },
  'elicitation': {
    displayName: 'elicitation',
    description: 'Structured form / OAuth handoff requested.',
    defaultSound: 'Funk',
    toastTitle: 'input requested',
    priority: 3,
    tier: 'sub',
  },
  'session-spawned': {
    displayName: 'session-spawned',
    description: 'A new session was just created.',
    defaultSound: 'Blow',
    toastTitle: 'session started',
    priority: 0,
    tier: 'lifecycle',
  },
  'session-resumed': {
    displayName: 'session-resumed',
    description: 'A dormant session was woken up.',
    defaultSound: 'Blow',
    toastTitle: 'session resumed',
    priority: 0,
    tier: 'lifecycle',
  },
  'session-stopped': {
    displayName: 'session-stopped',
    description: 'A session was torn down.',
    defaultSound: 'Bottle',
    toastTitle: 'session stopped',
    priority: 0,
    tier: 'lifecycle',
  },
  'tool-failed': {
    displayName: 'tool-failed',
    description: 'A single tool call returned an error (session not killed).',
    defaultSound: 'Ping',
    toastTitle: 'tool failed',
    priority: 2,
    tier: 'aspirational',
  },
};

/** All kinds in declaration order. Use this everywhere instead of hardcoded lists. */
export const ALERT_KINDS = Object.keys(ALERTS) as AlertKind[];

/** Convenience type guard for runtime values coming from clients / wire. */
export function isAlertKind(v: unknown): v is AlertKind {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ALERTS, v);
}

export function priorityOf(kind: AlertKind): number {
  return ALERTS[kind].priority;
}

export function defaultSoundOf(kind: AlertKind): string {
  return ALERTS[kind].defaultSound;
}

/** "MinionHQ: agent finished — feat/data-viz" */
export function browserToastTitle(kind: AlertKind, sessionLabel?: string | null): string {
  const tag = sessionLabel ? ` — ${sessionLabel}` : '';
  return `MinionHQ: ${ALERTS[kind].toastTitle}${tag}`;
}

/**
 * JSON-serializable form of the catalogue, exposed at `/api/alerts/catalog`
 * for the chimes picker. The shape is deliberately flat and stable so
 * the static HTML page can be a thin renderer.
 */
export interface AlertCatalogEntry extends AlertSpec {
  id: AlertKind;
}

export function alertCatalog(): AlertCatalogEntry[] {
  return ALERT_KINDS.map((id) => ({ id, ...ALERTS[id] }));
}
