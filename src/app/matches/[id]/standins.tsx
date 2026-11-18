import { MATCH_STATUS } from "@/lib/constants";
import { standinAssignmentOpen } from "@/lib/league-lifecycle";
import { MATCH_ANCHOR } from "@/lib/match-anchors";
import { standinHubPath } from "@/lib/standin-offer";
import { loadSideNeeds } from "@/lib/standin-offer-service";
import Link from "@/components/app-link";
import {
  Card,
  CardBody,
  CardHeader,
  LinkArrow,
  PlayerLink,
  buttonClasses,
} from "@/components/ui";
import { loadDraftStatus, type MatchPageMatch, type MatchViewer } from "./load";

/**
 * The match page's Standins card for one of its captains, as a summary: who
 * is booked, what still needs cover, what waits on a captain's OK, and one
 * button to the game on the Standins page, where every standin control
 * lives (Tim, 2026-11-17: standins are coordinated in one place). It keeps
 * the card's anchor, so a link to `#match-standins` from an older Discord
 * post still lands here. Admins book any team from Admin tools on this page
 * or from /admin.
 */
export async function StandinSection({
  match,
  viewer,
}: {
  match: MatchPageMatch;
  viewer: MatchViewer;
}) {
  if (!viewer || !match.season.isActive) return null;
  const myTeamId =
    match.homeTeam.captainId === viewer.id
      ? match.homeTeamId
      : match.awayTeam.captainId === viewer.id
        ? match.awayTeamId
        : null;
  if (!myTeamId) return null;
  const { season } = match;
  const draftStatus =
    season.status === "DRAFT" ? await loadDraftStatus(match) : null;
  const assignOpen = standinAssignmentOpen(
    season.status,
    draftStatus,
    match.status,
  );
  const requests =
    match.status === MATCH_STATUS.COMPLETED ? [] : match.standinRequests;
  // Nothing booked or asked, and nothing can be: no card.
  if (!assignOpen && match.standins.length === 0 && requests.length === 0)
    return null;
  const need = assignOpen
    ? (
        await loadSideNeeds(
          { id: match.seasonId, status: season.status, teamSize: season.teamSize },
          [match.id],
        )
      ).get(`${match.id}:${myTeamId}`)
    : undefined;
  const teamNameOf = (teamId: string) =>
    teamId === match.homeTeamId ? match.homeTeam.name : match.awayTeam.name;
  const otherTeamName = teamNameOf(
    myTeamId === match.homeTeamId ? match.awayTeamId : match.homeTeamId,
  );
  const toAnswer = requests.filter((r) => r.teamId !== myTeamId);
  const mine = requests.filter((r) => r.teamId === myTeamId);
  const cta =
    toAnswer.length > 0 && assignOpen
      ? "Answer on the Standins page"
      : need
        ? need.offerCount > 0
          ? "Pick your standin"
          : "Find a standin"
        : "Manage standins";

  return (
    <Card id={MATCH_ANCHOR.standins} className="scroll-mt-24">
      <CardHeader
        title="Standins"
        subtitle="Booking, offers and requests are all on the Standins page."
      />
      <CardBody className="space-y-2 text-sm">
        {need ? (
          <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2">
            <span aria-hidden>✗ </span>
            {need.seats === 1
              ? "1 seat needs cover."
              : `${need.seats} seats need cover.`}
            {need.offerCount > 0 ? (
              <strong>
                {" "}
                {need.offerCount === 1
                  ? "1 standin said they can play."
                  : `${need.offerCount} standins said they can play.`}
              </strong>
            ) : null}
          </p>
        ) : null}
        {toAnswer.map((r) => (
          <p
            key={r.id}
            className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 [overflow-wrap:anywhere]"
          >
            <span aria-hidden>⏳ </span>
            <strong>{r.requestedBy.name}</strong> wants{" "}
            <strong>{r.standin.name}</strong> on {teamNameOf(r.teamId)} and
            needs your OK.
          </p>
        ))}
        {mine.map((r) => (
          <p key={r.id} className="text-muted [overflow-wrap:anywhere]">
            <span aria-hidden>⏳ </span>
            {r.standin.name} is waiting for the {otherTeamName} captain&apos;s
            OK.
          </p>
        ))}
        {match.standins.length > 0 ? (
          <ul className="space-y-1">
            {match.standins.map((a) => (
              <li key={a.id} className="[overflow-wrap:anywhere]">
                <PlayerLink userId={a.standin.id} className="font-semibold">
                  {a.standin.name}
                </PlayerLink>{" "}
                <span className="text-muted">
                  {a.replaced ? `in for ${a.replaced.name}` : "filling an open seat"}
                  {" · "}
                  {teamNameOf(a.teamId)}
                </span>
              </li>
            ))}
          </ul>
        ) : !need && requests.length === 0 ? (
          <p className="text-muted">No standins booked for this match.</p>
        ) : null}
        <Link
          href={standinHubPath(match.id)}
          className={buttonClasses(
            need || toAnswer.length > 0 ? "accent" : "secondary",
            "sm",
            "mt-1",
          )}
        >
          {cta} <LinkArrow />
        </Link>
      </CardBody>
    </Card>
  );
}
