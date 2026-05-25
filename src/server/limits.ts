// Centralized operational limits. These prevent unbounded resource use
// from a runaway agent or a buggy script hammering the API.

export const LIMITS = {
  /** Cap on live (non-dormant) sessions. Spawn rejects when reached. */
  MAX_LIVE_SESSIONS: 50,

  /** Max accepted JSON body size for POST endpoints (bytes). */
  MAX_BODY_BYTES: 64 * 1024,

  /** Max accepted raw (non-JSON) upload size — used by /api/attachments
   *  for clipboard-paste and drag-drop. Large enough for typical
   *  screenshots and a few-MB diagrams without letting a single agent
   *  fill the disk. */
  MAX_ATTACHMENT_BYTES: 20 * 1024 * 1024,

  /** How long a POST may stream before we give up (ms). */
  BODY_TIMEOUT_MS: 5_000,

  /** Max time we wait for in-flight PTY onExit handlers during shutdown (ms). */
  SHUTDOWN_GRACE_MS: 3_000,
} as const;
