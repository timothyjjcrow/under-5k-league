"use client";

import type { ReactNode } from "react";
import {
  PollClockProvider,
  YourTimeNote,
  usePollClock,
} from "@/components/match-night-poll/poll-clock";
import type { PollSlotView } from "@/lib/match-night-poll";

/**
 * The roll call's clock: the match-night poll's, read at the first match
 * night after the draft (RollCallView.clockAt), so the converted time is the
 * one a player will actually play at.
 */
export function RollCallClock({
  timeZone,
  clockAt,
  viewedAt,
  children,
}: {
  timeZone: string;
  clockAt: number;
  viewedAt: number;
  children: ReactNode;
}) {
  return (
    <PollClockProvider leagueZone={timeZone} clockAt={clockAt} viewedAt={viewedAt}>
      {children}
    </PollClockProvider>
  );
}

/**
 * The night on the viewer's own clock: "That's Saturday at 5 PM in your
 * local time (Eastern)." Nothing until the browser's zone is known (the
 * server's first paint names only the league's), and "That's your local
 * time too." for a player on the league's clock, so nobody has to wonder.
 */
export function RollCallYourTime({ slot }: { slot: PollSlotView }) {
  const { viewerZone, localZone } = usePollClock();
  if (viewerZone) return <YourTimeNote slot={slot} />;
  if (localZone) return <span>That&apos;s your local time too.</span>;
  return null;
}
