"use client";

// One "Add to calendar" control: a subscription for Apple Calendar or Outlook
// (webcal://), the same subscription through Google Calendar's add-by-URL
// page (Google won't open webcal links), or a one-off .ics download. It
// offers the team whose fixtures are on screen (the ?team= filter, else the
// reader's own team), with the whole league one tap away.

import { useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { buttonClasses } from "@/components/ui";
import { calendarFeedLinks } from "@/lib/calendar-links";
import { scheduleFilterTeamId } from "@/lib/schedule";
import { cn } from "@/lib/utils";

const OPTION =
  "flex min-h-11 items-center justify-between gap-3 rounded-lg px-3 text-sm text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60";

export function AddToCalendar({
  site,
  teams,
  initialTeamId,
}: {
  /** Canonical site origin, resolved on the server. */
  site: string;
  teams: { id: string; name: string }[];
  /** The reader's own team, offered when the URL picks none. */
  initialTeamId?: string | null;
}) {
  const params = useSearchParams();
  const teamId = scheduleFilterTeamId(
    params.get("team"),
    initialTeamId,
    teams.map((team) => team.id),
  );
  const team = teams.find((entry) => entry.id === teamId) ?? null;
  const [wholeLeague, setWholeLeague] = useState(false);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const chosen = team && !wholeLeague ? team : null;
  const links = calendarFeedLinks(chosen?.id, site);
  const scopeButton = (active: boolean) =>
    cn(
      "min-h-11 min-w-0 truncate rounded-md px-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
      active ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg",
    );

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className={buttonClasses("secondary", "sm")}
      >
        Add to calendar
      </button>
      {open ? (
        <div
          id={panelId}
          className="absolute left-0 top-full z-30 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-2 shadow-xl shadow-black/30 sm:left-auto sm:right-0"
        >
          {team ? (
            <div
              role="group"
              aria-label="Matches to add"
              className="mb-2 grid grid-cols-2 gap-1 rounded-lg bg-surface-2/60 p-1"
            >
              <button
                type="button"
                aria-pressed={!wholeLeague}
                title={team.name}
                onClick={() => setWholeLeague(false)}
                className={scopeButton(!wholeLeague)}
              >
                {team.name}
              </button>
              <button
                type="button"
                aria-pressed={wholeLeague}
                onClick={() => setWholeLeague(true)}
                className={scopeButton(wholeLeague)}
              >
                Whole league
              </button>
            </div>
          ) : null}
          <ul aria-label="Calendar apps">
            <li>
              <a href={links.subscribe} className={OPTION}>
                Apple Calendar or Outlook
              </a>
            </li>
            <li>
              <a
                href={links.google}
                target="_blank"
                rel="noopener noreferrer"
                className={OPTION}
              >
                <span>
                  Google Calendar
                  <span className="sr-only"> (opens in a new tab)</span>
                </span>
                <span aria-hidden className="text-muted">
                  ↗
                </span>
              </a>
            </li>
            <li>
              <a href={links.download} className={OPTION}>
                Download .ics file
              </a>
            </li>
          </ul>
          <p className="px-3 pb-1 pt-2 text-xs leading-relaxed text-muted">
            {chosen ? `${chosen.name}'s matches` : "Every league match"}. Apple,
            Outlook and Google keep moved matches up to date; a downloaded
            file is a one-time copy.
          </p>
        </div>
      ) : null}
    </div>
  );
}
