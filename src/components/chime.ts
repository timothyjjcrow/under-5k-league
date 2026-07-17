// ---- Bell "dong" notification (synthesized, no audio asset needed) ----------
// Shared by the live rooms (draft + inhouse). Plain module: the AudioContext
// is a browser global, so both rooms share one unlocked context.

let audioCtx: AudioContext | null = null;

/** Get (and resume) a shared AudioContext. Must be primed by a user gesture. */
function ensureAudioCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) audioCtx = new Ctor();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

/** Unlock audio on a user gesture (browsers block sound until then). */
export function unlockAudio() {
  ensureAudioCtx();
}

/** A short bell "dong": a stack of decaying partials struck together. */
export function playChime() {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 0.32;
  master.connect(ctx.destination);
  // Fundamental + bell-like overtones, each ringing out and fading.
  const partials: [number, number, number][] = [
    [523.25, 1.0, 1.7], // C5
    [1046.5, 0.5, 1.2],
    [1568.0, 0.22, 0.8],
    [2093.0, 0.1, 0.5],
  ];
  for (const [freq, gain, decay] of partials) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(gain, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + decay);
    osc.connect(g);
    g.connect(master);
    osc.start(now);
    osc.stop(now + decay + 0.05);
  }
}
