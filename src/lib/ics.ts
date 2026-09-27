// Minimal iCalendar (RFC 5545) builder for the match schedule — pure and
// unit-tested. Only the pieces calendar apps actually need: VCALENDAR,
// VEVENT with UTC times, text escaping, and CRLF line endings.

import { LEAGUE_CONFIG } from "./league-config";

/**
 * PRODID naming this league's calendar: "-//GGD2L//League Schedule//EN", or
 * "GGD2L Europe" on that site. The name comes from deploy config, so any
 * character that could break the `-//owner//product//EN` shape is dropped.
 */
export function calendarProductId(leagueName: string): string {
  const product =
    leagueName.replace(/[^A-Za-z0-9 .-]+/g, "").trim() || "GGD2L";
  return `-//${product}//League Schedule//EN`;
}

export type CalendarEvent = {
  /** Globally unique id, e.g. `${matchId}@league.example`. */
  uid: string;
  /** Stable event creation stamp. Do not substitute the feed request time. */
  stamp: Date;
  /**
   * Revision number (RFC 5545 SEQUENCE). Bump it whenever the time moves: a
   * calendar app that already holds the event keeps the old copy otherwise.
   */
  sequence?: number;
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

/**
 * Fold a content line to RFC 5545 §3.1: no line longer than 75 OCTETS,
 * continuations prefixed with a single space (which costs one of their 75).
 * Splits are octet-counted but always land on character boundaries, so a
 * multi-byte team name never gets torn mid-codepoint.
 */
export function foldIcsLine(line: string): string[] {
  const LIMIT = 75;
  const out: string[] = [];
  let current = "";
  let currentOctets = 0;
  let budget = LIMIT;
  for (const ch of line) {
    const octets = Buffer.byteLength(ch, "utf8");
    if (currentOctets + octets > budget) {
      out.push(current);
      current = " ";
      currentOctets = 1;
      budget = LIMIT;
    }
    current += ch;
    currentOctets += octets;
  }
  out.push(current);
  return out;
}

/** Build a complete VCALENDAR document (CRLF-joined). */
export function buildCalendar(name: string, events: CalendarEvent[]): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${calendarProductId(LEAGUE_CONFIG.name)}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(name)}`,
    // How often a subscribed calendar should re-fetch. Apple Calendar and
    // Outlook honour these; Google Calendar picks its own interval.
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const e of events) {
    const end = new Date(e.start.getTime() + e.durationMinutes * 60_000);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}`,
      `SEQUENCE:${Number.isSafeInteger(e.sequence) && e.sequence! > 0 ? e.sequence : 0}`,
      `DTSTAMP:${icsDate(e.stamp)}`,
      `DTSTART:${icsDate(e.start)}`,
      `DTEND:${icsDate(end)}`,
      `SUMMARY:${escapeIcsText(e.summary)}`,
    );
    if (e.description)
      lines.push(`DESCRIPTION:${escapeIcsText(e.description)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.flatMap(foldIcsLine).join("\r\n") + "\r\n";
}
