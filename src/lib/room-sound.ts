/**
 * The live rooms' Sound toggle (the draft room's and the inhouse room's).
 *
 * Browsers hold a page's audio until a click, tap or key press on that page
 * (`armAudioUnlock`, `src/components/chime.ts`), after every load. So a bell
 * the viewer wants is not yet a bell that can ring: "Sound on" on a page
 * nobody has touched was a promise the room couldn't keep, and the players
 * who most need it never touch the room (a Discord link's one-tap join, a
 * reload, a restored tab), then tab away and miss "match found".
 */
export type SoundButtonState = "on" | "locked" | "muted";

/** What the toggle shows: muted, on, or wanted but held by the browser. */
export function soundButtonState(
  soundOn: boolean,
  audioUnlocked: boolean,
): SoundButtonState {
  if (!soundOn) return "muted";
  return audioUnlocked ? "on" : "locked";
}

/**
 * What a tap on the toggle stores. A locked bell is turned ON by the tap
 * (which is also the gesture that unlocks it), never muted: tapping a bell
 * that reads "Turn on sound" must not silence it.
 */
export function soundToggleNext(
  soundOn: boolean,
  audioUnlocked: boolean,
): boolean {
  return soundButtonState(soundOn, audioUnlocked) === "locked" ? true : !soundOn;
}
