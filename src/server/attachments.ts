// Security primitives for the /api/attachments endpoint, factored out so
// they can be unit-tested without spinning up the HTTP server. The HTTP
// handler in index.ts orchestrates: id validation → session lookup →
// body streaming → name sanitisation → containment check → disk write.
// Everything that is pure logic lives here.

import { join } from 'node:path';

/** Untrusted session-id strings must look like a UUID-ish hex+dash blob.
 *  Same shape used elsewhere for ids on the wire. Kept here to avoid
 *  duplicating the regex inline at every endpoint. */
export const SESSION_ID_RE = /^[a-f0-9-]{8,}$/i;

/**
 * Replace anything outside `[A-Za-z0-9._-]` with `_`, then take the last
 * 80 chars so a maliciously long name can't blow up the inode. The 80
 * char cap is well above any realistic filename and well below ext4's
 * 255-byte limit. The extension is preserved because the model uses it
 * to pick a parser (e.g. .png vs .pdf).
 *
 * `..` survives as `__` (benign, just a literal underscore name), and
 * path separators are stripped — so this function alone makes traversal
 * impossible. The containment check in `assertInside` is belt-and-
 * suspenders for future maintainers.
 */
export function sanitizeAttachmentName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80);
  return cleaned || 'attachment.bin';
}

/** Throws if `child` would resolve outside `parent`. Both must be
 *  already-absolute, normalised paths. */
export function assertInside(parent: string, child: string): void {
  if (child === parent) return;
  if (!child.startsWith(parent + '/')) {
    throw new Error(`path escapes parent: ${child}`);
  }
}

/**
 * Build the on-disk path for a new attachment. `baseDir` should be the
 * per-session attachments directory; the returned path includes a
 * monotonic timestamp prefix so two uploads of the same filename never
 * collide. Throws if the resulting path escapes `baseDir` (it shouldn't
 * — `sanitizeAttachmentName` already strips separators — but the check
 * is here so the invariant is enforced rather than implied).
 */
export function buildAttachmentPath(baseDir: string, rawName: string, now: number = Date.now()): {
  path: string;
  name: string;
} {
  const safeName = sanitizeAttachmentName(rawName);
  const path = join(baseDir, `${now}-${safeName}`);
  assertInside(baseDir, path);
  return { path, name: safeName };
}
