/**
 * Deterministic per-repo accent colors.
 *
 * Every tab gets an outline colored by its repo so it's instantly obvious
 * which repository a given session lives in. The mapping is stable across
 * reloads via two layers:
 *
 *   1. A pure hash(repoPath) → palette[idx] function, so even without any
 *      stored state a repo always lands on the same color.
 *   2. A localStorage cache (cm.repoColors) so the assignment is visible /
 *      auditable from devtools and survives palette changes if we ever
 *      decide to override an assignment manually.
 *
 * Palette is 12 colors chosen to read well on dark backgrounds and to be
 * distinguishable at small sizes (tab outlines, status dots). Roughly evenly
 * spaced around the color wheel — picked from Tokyo Night / Monokai-adjacent
 * dark-mode palettes.
 */

export const REPO_COLOR_PALETTE: readonly string[] = [
  '#7aa2f7', // 0  blue
  '#73daca', // 1  mint
  '#9ece6a', // 2  green
  '#e0af68', // 3  amber
  '#ff9e64', // 4  orange
  '#f7768e', // 5  coral
  '#ff7eb6', // 6  pink
  '#bb9af7', // 7  violet
  '#b4a4ff', // 8  lavender
  '#2ac3de', // 9  teal
  '#7dcfff', // 10 cyan
  '#c3e88d', // 11 lime
] as const;

const LS_KEY = 'cm.repoColors';

interface StoredMap { [repoKey: string]: number }

function loadStored(): StoredMap {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === 'object') return obj as StoredMap;
  } catch { /* ignore */ }
  return {};
}

function saveStored(m: StoredMap): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}

/**
 * djb2-style string hash → 32-bit unsigned int. Fast, stable, no deps.
 */
function hash32(s: string): number {
  let h = 5381 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

const memo = new Map<string, string>();
const stored: StoredMap = typeof localStorage !== 'undefined' ? loadStored() : {};

/**
 * Resolve the accent color for a given repository path.
 *
 * - If the path is empty / null, returns the first palette entry as a
 *   "neutral" default.
 * - If a color was previously stored, that wins.
 * - Otherwise, deterministically hash → palette index, persist, return.
 *
 * @param repoPath  Repo root path (server-canonical). Treated case-sensitively
 *                  on POSIX but normalized to NFC + trailing-slash-stripped
 *                  for stability across reloads / OS conventions.
 */
export function colorForRepo(repoPath: string | null | undefined): string {
  const key = (repoPath ?? '').normalize('NFC').replace(/\/+$/, '');
  if (!key) return REPO_COLOR_PALETTE[0];

  const cached = memo.get(key);
  if (cached) return cached;

  let idx = stored[key];
  if (typeof idx !== 'number' || idx < 0 || idx >= REPO_COLOR_PALETTE.length) {
    idx = hash32(key) % REPO_COLOR_PALETTE.length;
    stored[key] = idx;
    saveStored(stored);
  }
  const color = REPO_COLOR_PALETTE[idx];
  memo.set(key, color);
  return color;
}
