"use client";

import {
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  slotHour,
  slotInZone,
  slotOnClock,
  zoneOffsetMinutes,
  type PollSlotView,
} from "@/lib/match-night-poll";
import { zoneLabel, zoneName } from "@/lib/zone-label";
import { LEAGUE_LOCALE } from "@/lib/zoned-time";
import { cn } from "@/lib/utils";

const emptySubscribe = () => () => {};

function browserZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

type Clock = {
  /** The zone times are shown on, or null for the league's own clock. */
  zone: string | null;
  /** The league's zone, "America/Los_Angeles". */
  leagueZone: string;
  /** The viewer's zone when it differs from the league's, else null. */
  viewerZone: string | null;
  /** The viewer's zone once the browser has told us (even when it is the
   *  league's), else null: before hydration, or a zone Intl can't read. */
  localZone: string | null;
  setUseLeague: (league: boolean) => void;
  useLeague: boolean;
};

const ClockContext = createContext<Clock | null>(null);

/**
 * Which clock a poll's times are shown on. Times are stored on the league's
 * clock; every viewer sees them on their own unless they switch to the
 * league's. The viewer's zone is read after hydration (the server can't know
 * it), so the first paint shows the league's clock and the switch to the
 * viewer's is the useLocalTimeText trick: never a hydration mismatch.
 */
export function PollClockProvider({
  leagueZone,
  sampleAt,
  children,
}: {
  leagueZone: string;
  /** An instant in the poll's week, to tell whether the two clocks differ. */
  sampleAt: number;
  children: ReactNode;
}) {
  const zone = useSyncExternalStore(emptySubscribe, browserZone, () => null);
  const [useLeague, setUseLeague] = useState(false);
  const localZone = zone && slotInZone(sampleAt, zone) ? zone : null;
  const viewerZone =
    localZone && zoneOffsetMinutes(sampleAt, leagueZone, localZone) !== null
      ? localZone
      : null;
  return (
    <ClockContext.Provider
      value={{
        zone: useLeague ? null : viewerZone,
        leagueZone,
        viewerZone,
        localZone,
        useLeague,
        setUseLeague,
      }}
    >
      {children}
    </ClockContext.Provider>
  );
}

export function usePollClock(): Clock {
  const clock = useContext(ClockContext);
  if (!clock) throw new Error("usePollClock needs a PollClockProvider");
  return clock;
}

/**
 * Which clock the times are on, in words: "your local time (Eastern time)",
 * "league time (Pacific time)" after the switch, or plain "Pacific time"
 * until the browser's zone is known (the server's first paint), so the card
 * never claims "local" before it is.
 */
export function useClockPhrase(): string {
  const { useLeague, localZone, leagueZone } = usePollClock();
  if (useLeague) return `league time (${zoneLabel(leagueZone)})`;
  if (localZone) return `your local time (${zoneLabel(localZone)})`;
  return zoneLabel(leagueZone);
}

/**
 * The one line that says whose clock the poll's times are on: "Times are
 * shown in your local time (Eastern time)." Always shown beside a grid, so a
 * player never has to guess, including one whose local time is the league's.
 */
export function ClockNote({ className }: { className?: string }) {
  const phrase = useClockPhrase();
  return (
    <p className={cn("text-sm text-fg", className)}>
      <span aria-hidden>🕒 </span>
      Times are shown in <span className="font-semibold">{phrase}</span>.
    </p>
  );
}

/**
 * "Your local time (Eastern) | League time (Pacific)": shown only when the
 * viewer's clock differs from the league's.
 */
export function ClockToggle({ className }: { className?: string }) {
  const { viewerZone, leagueZone, useLeague, setUseLeague } = usePollClock();
  if (!viewerZone) return null;
  const option = (league: boolean, text: string) => (
    <button
      type="button"
      aria-pressed={useLeague === league}
      onClick={() => setUseLeague(league)}
      className={cn(
        "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none",
        useLeague === league
          ? "bg-surface-3 text-fg shadow-sm"
          : "text-muted hover:text-fg",
      )}
    >
      {text}
    </button>
  );
  return (
    <div
      role="group"
      aria-label="Show times on"
      className={cn(
        "inline-flex rounded-lg border border-line bg-surface-2/60 p-0.5",
        className,
      )}
    >
      {option(false, `Your local time (${zoneName(viewerZone)})`)}
      {option(true, `League time (${zoneName(leagueZone)})`)}
    </div>
  );
}

/** "+1"/"−1" after a time that lands on the next or previous day. */
export function DayShift({ shift }: { shift: -1 | 0 | 1 }) {
  if (shift === 0) return null;
  return (
    <>
      <sup aria-hidden className="ml-0.5 text-[10px] font-semibold text-accent">
        {shift > 0 ? "+1" : "−1"}
      </sup>
      <span className="sr-only">
        {shift > 0 ? " the next day" : " the day before"}
      </span>
    </>
  );
}

/**
 * A slot as "Sat 5 PM" on the shown clock. Always in the league's locale
 * (LEAGUE_LOCALE), never the browser's, so the server's first paint and the
 * hydrated one print the same text.
 */
export function useSlotOnClock() {
  const { zone } = usePollClock();
  return (slot: PollSlotView) => {
    const shown = slotOnClock(slot, zone);
    const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][shown.day];
    return { ...shown, text: `${day} ${slotHour(shown.minute, LEAGUE_LOCALE)}` };
  };
}

/**
 * "That's Saturday at 5 PM in your local time (Eastern)." beside a
 * league-time label, when the viewer's clock differs.
 */
export function YourTimeNote({ slot }: { slot: PollSlotView }) {
  const { viewerZone } = usePollClock();
  if (!viewerZone) return null;
  const shown = slotOnClock(slot, viewerZone);
  const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
    shown.day
  ];
  return (
    <span>
      That&apos;s {day} at {slotHour(shown.minute, LEAGUE_LOCALE)} in your local
      time ({zoneName(viewerZone)}).
    </span>
  );
}
