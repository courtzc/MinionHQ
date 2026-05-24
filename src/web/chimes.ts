// Web Audio synthesized chimes. Three distinct timbres so they're
// instantly distinguishable without volume cranked:
//
//   needs-input — soft two-note rising ping (calm "hey")
//   done        — bright major-third arpeggio (cheerful)
//   error       — descending minor semitone (gentle alert, not jarring)

export type ChimeKind = 'needs-input' | 'done' | 'error';

let ctx: AudioContext | null = null;
function ac(): AudioContext {
  if (!ctx) {
    const Ctor: typeof AudioContext =
      (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    ctx = new Ctor();
  }
  return ctx;
}

function note(freq: number, startAt: number, durSec: number, gain = 0.18, type: OscillatorType = 'sine') {
  const a = ac();
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(g);
  g.connect(a.destination);
  // ADSR-ish envelope: quick attack, smooth release
  const t0 = a.currentTime + startAt;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + durSec);
  osc.start(t0);
  osc.stop(t0 + durSec + 0.05);
}

let lastPlayedAt = 0;
const MIN_GAP_MS = 250;

export function playChime(kind: ChimeKind): void {
  // Throttle so a burst of events doesn't spam audio.
  const now = Date.now();
  if (now - lastPlayedAt < MIN_GAP_MS) return;
  lastPlayedAt = now;

  try {
    const a = ac();
    if (a.state === 'suspended') a.resume().catch(() => { /* ignore */ });
    switch (kind) {
      case 'needs-input':
        // Soft rising two-note: C5 → E5 (262 → 330)... bumped up an octave
        note(523.25, 0.0, 0.18, 0.14, 'sine');
        note(659.25, 0.16, 0.28, 0.14, 'sine');
        break;
      case 'done':
        // Major arpeggio C E G C (cheerful, finished)
        note(523.25, 0.0, 0.16, 0.14, 'triangle');
        note(659.25, 0.10, 0.16, 0.14, 'triangle');
        note(783.99, 0.20, 0.16, 0.14, 'triangle');
        note(1046.5, 0.30, 0.34, 0.16, 'triangle');
        break;
      case 'error':
        // Descending minor: A4 → F4 (440 → 349) with a softer square for "alert" character
        note(440, 0.0, 0.22, 0.16, 'square');
        note(349.23, 0.20, 0.36, 0.16, 'square');
        break;
    }
  } catch (e) {
    console.warn('[chime] failed:', e);
  }
}

export function unlockAudio(): void {
  // Browsers require a user gesture before audio can play. Call this from
  // a click handler to pre-warm the AudioContext.
  try {
    const a = ac();
    if (a.state === 'suspended') a.resume().catch(() => { /* ignore */ });
  } catch { /* ignore */ }
}
