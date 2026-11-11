import Link from "@/components/app-link";
import { Badge, Card, CardBody, CardHeader, LinkArrow, buttonClasses, textLink } from "@/components/ui";
import { checkinCountsText } from "@/lib/checkin-side";
import { matchResultsOpen } from "@/lib/league-lifecycle";
import { matchAnchorPath } from "@/lib/match-anchors";
import { captainCardsOpen, captainJumps } from "@/lib/match-captain-jumps";
import { loadTeamWeek } from "@/lib/team-week-service";
import { cn } from "@/lib/utils";

const NOTE_TONE = {
  danger: "border-danger/40 bg-danger/10",
  accent: "border-accent/40 bg-accent/10",
  muted: "border-line bg-surface-2/40 text-muted",
} as const;

/**
 * "Match prep", on a team's own page for its captain and players: how the
 * side's check-ins stand for the next series, who is standing in, what is
 * waiting (a player out with no cover, a standin request, a ready check) and
 * a link straight to the match-page card that deals with each. The team page
 * used to show a date and "Open match", so a captain had to open the match
 * and scroll to its tools to learn anything was waiting. Renders nothing for
 * anyone not on the side's match-night roster.
 */
export async function MatchPrep({
  match,
  season,
  draftStatus,
  teamId,
  otherTeamName,
  roundLabel,
  viewer,
  nowMs,
}: {
  match: {
    id: string;
    status: string;
    phase: string;
    scheduledAt: Date | null;
    homeTeamId: string;
    awayTeamId: string;
  };
  season: { isActive: boolean; status: string };
  draftStatus: string | null | undefined;
  teamId: string;
  otherTeamName: string;
  /** matchRoundLabel of the fixture ("Week 5", "Semifinal"). */
  roundLabel: string;
  viewer: { id: string; role: string };
  nowMs: number;
}) {
  const open = captainCardsOpen({ status: match.status, season }, draftStatus);
  const week = await loadTeamWeek({
    match,
    teamId,
    otherTeamName,
    viewer,
    ...open,
    nowMs,
  });
  if (!week) return null;
  const { side, notes } = week;
  const captain = side.role === "captain";
  const live = match.status === "LIVE";
  const names = side.names
    ? [
        { label: live ? "Ready" : "In", tone: "text-success", list: side.names.in },
        { label: "Out", tone: "text-danger-soft", list: side.names.out },
        {
          label: "Covered",
          tone: "text-muted",
          list: side.names.covered.map((c) => `${c.name} by ${c.by}`),
        },
        { label: "No reply", tone: "text-accent", list: side.names.noReply },
      ].filter((row) => row.list.length > 0)
    : [];
  // A captain's jumps are the scoreboard's own (captainJumps), landing on the
  // same cards; a player just opens the match, where they check in.
  const jumps = captain
    ? captainJumps({
        resultsOpen: matchResultsOpen(season.status, match.phase),
        seriesStarted: live,
        kickoffMs: match.scheduledAt?.getTime() ?? null,
        nowMs,
        ...open,
      })
    : [];
  return (
    <Card id="team-prep" className="scroll-mt-40 border-accent/40">
      <CardHeader
        title="Match prep"
        headingLevel={2}
        subtitle={`${roundLabel} vs ${otherTeamName} · only your team sees this`}
        action={<Badge tone="accent">Your team</Badge>}
      />
      <CardBody className="space-y-3 text-sm">
        <div>
          <p className="[overflow-wrap:anywhere]">
            <span className="font-medium">Check-ins:</span>{" "}
            <span className="text-muted">
              {checkinCountsText(side.counts, live)}
            </span>
          </p>
          {names.length > 0 ? (
            <dl className="mt-1.5 space-y-0.5 text-xs">
              {names.map((row) => (
                <div key={row.label} className="flex min-w-0 gap-2">
                  <dt className={cn("w-16 shrink-0 font-medium", row.tone)}>
                    {row.label}
                  </dt>
                  <dd className="min-w-0 text-muted [overflow-wrap:anywhere]">
                    {row.list.join(", ")}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
        {notes.length > 0 ? (
          <ul className="space-y-2">
            {notes.map((note) => (
              <li
                key={note.key}
                className={cn(
                  "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2",
                  NOTE_TONE[note.tone],
                )}
              >
                <span className="min-w-[12rem] flex-1 [overflow-wrap:anywhere]">
                  {note.text}
                </span>
                {note.link ? (
                  <Link
                    href={matchAnchorPath(match.id, note.link.anchor)}
                    className={textLink("shrink-0 font-medium")}
                  >
                    {note.link.label} <LinkArrow />
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {jumps.map((jump) => (
            <Link
              key={jump.anchor}
              href={matchAnchorPath(match.id, jump.anchor)}
              className={buttonClasses(jump.variant, "sm")}
            >
              {jump.label}
            </Link>
          ))}
          {captain ? null : (
            <Link
              href={`/matches/${match.id}`}
              className={buttonClasses("secondary", "sm")}
            >
              Open the match to check in
            </Link>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
