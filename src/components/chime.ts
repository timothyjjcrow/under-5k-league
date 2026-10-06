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
  if (!audioCtx) {
    audioCtx = new Ctor();
    audioCtx.onstatechange = () => {
      for (const listener of READY_LISTENERS) listener();
    };
  }
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

const READY_LISTENERS = new Set<() => void>();

/** Is sound actually able to play right now (the context unlocked)? */
export function audioReady(): boolean {
  return audioCtx?.state === "running";
}

/** For useSyncExternalStore: re-read audioReady when the context changes. */
export function subscribeAudioReady(onChange: () => void): () => void {
  READY_LISTENERS.add(onChange);
  return () => {
    READY_LISTENERS.delete(onChange);
  };
}

/** Unlock audio on a user gesture (browsers block sound until then). */
export function unlockAudio() {
  const ctx = ensureAudioCtx();
  if (!ctx || ctx.state === "running") return;
  // iOS Safari unlocks a context only by playing something inside the
  // gesture; a one-sample silent buffer does it without a sound.
  try {
    const source = ctx.createBufferSource();
    source.buffer = ctx.createBuffer(1, 1, 22050);
    source.connect(ctx.destination);
    source.start(0);
  } catch {
    // An exotic context that refuses; the resume above still applies.
  }
}

/** The gestures browsers count as user activation for audio. */
const UNLOCK_EVENTS = ["pointerup", "touchend", "click", "keydown"] as const;

/**
 * Unlock audio on the viewer's first real gesture, and keep listening until
 * the context is actually running. Both rooms used a one-time `pointerdown`
 * listener, which is not an activation gesture (the spec counts pointerup,
 * touchend, click and keydown; iOS Safari unlocks only inside touchend or
 * click), so on phones it removed itself without unlocking, and a pool
 * player, who never presses a room button, never heard "you're on the
 * block". Returns the cleanup for an effect.
 */
export function armAudioUnlock(): () => void {
  if (typeof document === "undefined") return () => {};
  const stop = () => {
    for (const type of UNLOCK_EVENTS) {
      document.removeEventListener(type, onGesture, true);
    }
  };
  function onGesture() {
    unlockAudio();
    if (audioCtx?.state === "running") stop();
  }
  for (const type of UNLOCK_EVENTS) {
    document.addEventListener(type, onGesture, true);
  }
  return stop;
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
