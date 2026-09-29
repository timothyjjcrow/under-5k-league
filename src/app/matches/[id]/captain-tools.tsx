import { prisma } from "@/lib/prisma";
import { canViewLeagueContact } from "@/lib/visibility";
import { MATCH_ANCHOR } from "@/lib/match-anchors";
import type { SessionUser } from "@/lib/auth";
import { DiscordTag } from "@/components/discord-tag";
import { Badge, PlayerLink } from "@/components/ui";
import type { MatchPageMatch } from "./load";
import { ReportResultSection } from "./report-result";
import { RescheduleSection } from "./reschedule";
import { StandinSection } from "./standins";

/**
 * A captain's own tools for this match, below the scoreboard and any box
 * scores: the other captain's contact, then the cards that may need an answer
 * (a proposed time, a player who can't make it), then lobby setup and
 * reporting with their own anchor for the scoreboard's jump. The page renders
 * it only for a captain of this match while the season is active and the
 * series isn't complete.
 */
export function CaptainTools({
  match,
  viewer,
  seriesStarted,
  renderedAt,
}: {
  match: MatchPageMatch;
  viewer: SessionUser;
  /** A game is imported (the Standins card locks removal). */
  seriesStarted: boolean;
  renderedAt: number;
}) {
  const isCaptain =
    match.homeTeam.captainId === viewer.id ||
    match.awayTeam.captainId === viewer.id;
  const opposingCaptainId =
    match.homeTeam.captainId === viewer.id
      ? match.awayTeam.captainId
      : match.homeTeam.captainId;
  return (
    <section
      id={MATCH_ANCHOR.tools}
      className="scroll-mt-24 space-y-4"
      aria-labelledby="match-tools-title"
    >
      <div className="flex items-center gap-3 border-t border-line pt-6">
        <span
          aria-hidden
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-accent/25 bg-accent/10 text-accent"
        >
          ◇
        </span>
        <h2
          id="match-tools-title"
          className="font-display text-2xl font-semibold"
        >
          Captain tools
        </h2>
        <Badge className="ml-auto">Your match</Badge>
      </div>
      <OpposingCaptain
        captainId={opposingCaptainId}
        showContact={canViewLeagueContact(
          viewer,
          opposingCaptainId,
          // A captain of this match in the active season: agreeing the
          // lobby and any new time with the other captain is their job.
          isCaptain,
        )}
      />
      {/* These components keep their own write-time capability gates,
          including locked reporting and stranded-proposal cleanup. The
          cards that may need an answer (a proposed time, a player who
          can't make it) come first; lobby setup and reporting follow,
          with their own anchor for the scoreboard's jump. */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <div className="min-w-0 empty:hidden">
          <RescheduleSection match={match} viewer={viewer} />
        </div>
        <div className="min-w-0 empty:hidden">
          <StandinSection
            match={match}
            viewer={viewer}
            seriesStarted={seriesStarted}
          />
        </div>
      </div>
      <div id={MATCH_ANCHOR.report} className="scroll-mt-24">
        <ReportResultSection
          match={match}
          viewer={viewer}
          renderedAt={renderedAt}
        />
      </div>
    </section>
  );
}

/**
 * "Opposing captain: <name> <copyable Discord handle>" at the top of Captain
 * tools. Captains agree lobby times, hosting and reschedules with each other,
 * and the handle used to be a team page or profile away.
 */
async function OpposingCaptain({
  captainId,
  showContact,
}: {
  captainId: string;
  /** canViewLeagueContact's answer for this viewer and captain. */
  showContact: boolean;
}) {
  const captain = await prisma.user.findUnique({
    where: { id: captainId },
    select: { id: true, name: true, discordName: true, discordId: true },
  });
  if (!captain) return null;
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
      <span>Opposing captain:</span>
      <PlayerLink
        userId={captain.id}
        className="font-medium text-fg [overflow-wrap:anywhere]"
      >
        {captain.name}
      </PlayerLink>
      {showContact ? (
        captain.discordName ? (
          <DiscordTag
            name={captain.discordName}
            verified={!!captain.discordId}
          />
        ) : (
          <span className="text-xs">(no Discord on file)</span>
        )
      ) : null}
    </p>
  );
}
