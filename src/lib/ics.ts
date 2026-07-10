// Minimal iCalendar (RFC 5545) builder for the match schedule — pure and
// unit-tested. Only the pieces calendar apps actually need: VCALENDAR,
// VEVENT with UTC times, text escaping, and CRLF line endings.

export type CalendarEvent = {
  /** Globally unique id, e.g. `${matchId}@league.example`. */
  uid: string;
  start: Date;
  durationMinutes: number;
  summary: string;
  description?: string;
  url?: string;
};

/** Escape TEXT per RFC 5545: backslash, semicolon, comma, newline. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** UTC timestamp in iCalendar basic format: 20260712T020000Z. */
export function icsDate(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/** Build a complete VCALENDAR document (CRLF-joined). */
export function buildCalendar(
  name: string,
  events: CalendarEvent[],
): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//LD2L//League Schedule//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(name)}`,
  ];
  for (const e of events) {
    const end = new Date(e.start.getTime() + e.durationMinutes * 60_000);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}`,
      `DTSTAMP:${icsDate(new Date())}`,
      `DTSTART:${icsDate(e.start)}`,
      `DTEND:${icsDate(end)}`,
      `SUMMARY:${escapeIcsText(e.summary)}`,
    );
    if (e.description) lines.push(`DESCRIPTION:${escapeIcsText(e.description)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
