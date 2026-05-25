// macOS system-sound chime engine. Replaces the older synth oscillator
// implementation now that we transcode the system AIFFs server-side
// (see /api/system-sound/*). The picker page (chimes.html) walks the user
// through auditioning every sound — the mapping below is what they picked.
//
// All sounds are loaded lazily on first play, decoded via Web Audio's
// `decodeAudioData`, then cached as `AudioBuffer`s for instant replay.
// Chromium browsers can't decode AIFF directly, but the server transcodes
// to FLLR-stripped 16-bit LE PCM WAV which decodes everywhere.
//
// The picker assigns one chime per "kind" — a logical event class. The
// dispatcher (alertDispatcher.ts) picks the kind, this module just plays it.
//
// IMPORTANT: keep this set in sync with `AlertKind` in alertDispatcher.ts.

export type ChimeKind =
  | 'needs-input'      // generic "I need a human" (fallback when cause unknown)
  | 'agent-finished'   // turn complete, ready for next prompt
  | 'error'            // session went into error state
  | 'ask-user'         // agent invoked the ask_user interactive tool
  | 'permission'       // permission.requested gate awaiting approval
  | 'elicitation'      // elicitation.requested prompt
  | 'session-spawned'  // user just started a new minion
  | 'session-resumed'  // user resumed a dormant minion
  | 'session-stopped'  // session ended (clean exit or close)
  | 'tool-failed';     // a single tool call failed (session keeps running)

// User-picked mapping (May 2026, via chimes.html picker). Each value is the
// macOS system sound name (no extension); we resolve it through
// /api/system-sound/system/<name>.aiff which transcodes on demand.
const CHIME_MAP: Record<ChimeKind, string | null> = {
  'needs-input': 'Hero',
  'agent-finished': 'Submarine',
  'error': 'Sosumi',
  'ask-user': 'Hero',
  'permission': 'Purr',
  'elicitation': 'Funk',
  'session-spawned': 'Blow',
  'session-resumed': 'Blow',
  'session-stopped': 'Bottle',
  'tool-failed': 'Ping',
};

// Per-kind gain. macOS system sounds vary wildly in loudness — Submarine
// is gentle, Sosumi is sharp. Adjust here if any feel out of balance; the
// goal is roughly equal perceived loudness for a normal listening level.
const CHIME_GAIN: Partial<Record<ChimeKind, number>> = {
  // 1.0 = nominal; below 1 reduces, above 1 boosts (use sparingly).
};

let ctx: AudioContext | null = null;
function ac(): AudioContext {
  if (!ctx) {
    const Ctor: typeof AudioContext =
      (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    ctx = new Ctor();
  }
  return ctx;
}
async function unlockedAc(): Promise<AudioContext> {
  const a = ac();
  if (a.state === 'suspended') {
    try { await a.resume(); } catch { /* ignore */ }
  }
  return a;
}

// Decoded AudioBuffers keyed by sound name. The fetch + decode happens once
// per page load per sound, then play() is a synchronous BufferSource start.
const bufferCache = new Map<string, AudioBuffer>();
const inflight = new Map<string, Promise<AudioBuffer>>();

async function loadBuffer(name: string): Promise<AudioBuffer> {
  const cached = bufferCache.get(name);
  if (cached) return cached;
  const pending = inflight.get(name);
  if (pending) return pending;
  const a = ac();
  const url = `/api/system-sound/system/${encodeURIComponent(name)}.aiff`;
  // cache: 'reload' bypasses any stale browser disk entry from a previous
  // deploy that served raw AIFF — the modern server always returns WAV.
  const p = fetch(url, { cache: 'reload' })
    .then(async (r) => {
      if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
      const ab = await r.arrayBuffer();
      return await new Promise<AudioBuffer>((resolve, reject) => {
        try {
          const ret = a.decodeAudioData(ab, resolve, reject);
          if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
        } catch (e) { reject(e); }
      });
    })
    .then((buf) => {
      bufferCache.set(name, buf);
      inflight.delete(name);
      return buf;
    })
    .catch((e) => {
      inflight.delete(name);
      throw e;
    });
  inflight.set(name, p);
  return p;
}

let lastPlayedAt = 0;
// Per-page-load guard against literal-overlap; the real "one alert per event"
// dedup happens upstream in the debouncer in alertDispatcher.ts. This just
// keeps two chimes from playing simultaneously if two different sessions
// happen to settle in the same animation frame.
const MIN_GAP_MS = 80;

export function playChime(kind: ChimeKind): void {
  const now = Date.now();
  if (now - lastPlayedAt < MIN_GAP_MS) return;
  lastPlayedAt = now;

  const soundName = CHIME_MAP[kind];
  if (!soundName) return; // mapped to silence — fine.

  // Fire-and-forget — we don't want a slow decode to block the UI thread
  // or hold up the dispatcher. Errors are logged and swallowed.
  (async () => {
    try {
      const a = await unlockedAc();
      const buf = await loadBuffer(soundName);
      const src = a.createBufferSource();
      src.buffer = buf;
      const g = a.createGain();
      g.gain.value = CHIME_GAIN[kind] ?? 0.9;
      src.connect(g);
      g.connect(a.destination);
      src.start();
    } catch (e) {
      console.warn('[chime] play failed:', kind, soundName, e);
    }
  })();
}

export function unlockAudio(): void {
  // Pre-warm the AudioContext on first user gesture so the very first chime
  // doesn't lose its envelope to the resume() race. Also kicks off a fetch
  // for the most common chime so playback is instant on first event.
  void unlockedAc().then(() => {
    // Speculatively prefetch the highest-frequency chimes.
    const warm: ChimeKind[] = ['agent-finished', 'needs-input', 'ask-user'];
    for (const k of warm) {
      const name = CHIME_MAP[k];
      if (name) loadBuffer(name).catch(() => { /* ignore prefetch errors */ });
    }
  });
}
