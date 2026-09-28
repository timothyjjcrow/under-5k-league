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
  align = "start",
}: {
  /** Canonical site origin, resolved on the server. */
  site: string;
  teams: { id: string; name: string }[];
  /** The reader's own team, offered when the URL picks none. */
  initialTeamId?: string | null;
  /**
   * Which edge of the button the menu lines up with. "start" follows where
   * the button actually sits: its left edge when the button is on the left
   * half of the screen, its right edge otherwise. "end" suits one kept at
   * the right edge of a card.
   */
  align?: "start" | "end";
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
  const [fromRight, setFromRight] = useState(false);
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
        onClick={() => {
          // Measure rather than trust a breakpoint: Schedule's page title
          // keeps the button beside the heading from about 460px, well below
          // `sm`, and a left-anchored menu there ran 167px off the screen.
          if (!open && button.current) {
            const box = button.current.getBoundingClientRect();
            setFromRight(box.left + box.width / 2 > window.innerWidth / 2);
          }
          setOpen((value) => !value);
        }}
        className={buttonClasses("secondary", "sm")}
      >
        Add to calendar
      </button>
      {open ? (
        <div
          id={panelId}
          className={cn(
            "absolute top-full z-30 mt-2 rounded-xl border border-line bg-surface p-2 shadow-xl shadow-black/30",
            align === "end"
              ? "right-0 w-[min(20rem,calc(100vw-4rem))]"
              : cn(
                  "w-[min(20rem,calc(100vw-2rem))]",
                  fromRight ? "right-0" : "left-0",
                ),
          )}
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
