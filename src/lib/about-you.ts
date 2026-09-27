// The signup form's one free-text box, "About you (public, shown to captains)".
//
// It replaced two boxes that read almost the same ("What you want from the
// league" and "Note for captains"), of which the pool only ever showed one.
// Both stored columns stay: new saves write the text to `captainNote` (what
// the pool, the draft room and the profile lead with) and clear `statement`.
// Rows saved before the merge keep both, and every surface shows them JOINED
// here, so nothing anyone wrote is dropped.

/** The box's limit: room for two old 1000-character answers side by side. */
export const ABOUT_MAX_LENGTH = 2000;

/** Paragraph break between an old note and old goals when they're joined. */
const PARAGRAPH = "\n\n";

type AboutParts = {
  captainNote?: string | null;
  statement?: string | null;
};

/** Browsers post textarea line breaks as CRLF; store and compare LF only. */
function normalizeBreaks(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * What a signup says about the player, as one text: the captain note first
 * (it was written to captains), then the old goals. Blank parts are skipped,
 * and a part repeated word for word is shown once. Empty string when there is
 * nothing to show. `separator` lets a one-line surface join with " · ".
 */
export function aboutText(parts: AboutParts, separator = PARAGRAPH): string {
  const seen: string[] = [];
  for (const raw of [parts.captainNote, parts.statement]) {
    const text = normalizeBreaks(raw ?? "").trim();
    if (text && !seen.includes(text)) seen.push(text);
  }
  return seen.join(separator);
}

/**
 * The about text a signup submit asked to store. The merged form posts
 * `about`; a page loaded before the merge still posts the two old fields,
 * which are joined rather than dropped. Line breaks normalized, trimmed and
 * clamped to the box's limit.
 */
export function submittedAbout(form: FormData): string {
  const value = (key: string) => {
    const v = form.get(key);
    return typeof v === "string" ? v : "";
  };
  const raw = form.has("about")
    ? value("about")
    : aboutText({
        captainNote: value("captainNote"),
        statement: value("statement"),
      });
  return normalizeBreaks(raw).trim().slice(0, ABOUT_MAX_LENGTH);
}

/**
 * Did the player leave the box as the form showed it? Then the stored
 * columns are left exactly as they are: an old two-part answer is only
 * rewritten into the single field once someone actually edits it.
 */
export function aboutUnchanged(submitted: string, stored: AboutParts): boolean {
  return submitted === aboutText(stored).slice(0, ABOUT_MAX_LENGTH);
}
