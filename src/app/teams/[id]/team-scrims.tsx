import Link from "@/components/app-link";
import { LocalTime } from "@/components/local-time";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  LinkArrow,
  textLink,
} from "@/components/ui";
import { SCRIM_STATUS } from "@/lib/constants";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { prisma } from "@/lib/prisma";
import { scrimNotPlayedCutoff } from "@/lib/scrim-view";

const scrimSelect = {
  id: true,
  status: true,
  bestOf: true,
  scheduledAt: true,
  hostTeamId: true,
  hostScore: true,
  awayScore: true,
  hostTeam: { select: { name: true } },
  opponentTeam: { select: { name: true } },
} as const;

/**
 * The team's practice on its own page: what's coming up (with the lobby
 * setup a booked scrim needs), the last results and its scrim record. Kept
 * apart from the league card above it on purpose: scrims never touch
 * standings. An archived team shows the card only if it scrimmed.
 */
export async function TeamScrims({
  teamId,
  seasonId,
  seasonActive,
  nowMs,
}: {
  teamId: string;
  seasonId: string;
  seasonActive: boolean;
  nowMs: number;
}) {
  const ours = [{ hostTeamId: teamId }, { opponentTeamId: teamId }];
  const [upcoming, completed] = await Promise.all([
    seasonActive
      ? prisma.scrim.findMany({
          where: {
            seasonId,
            AND: [
              { OR: ours },
              {
                OR: [
                  { status: SCRIM_STATUS.LIVE },
                  {
                    status: SCRIM_STATUS.SCHEDULED,
                    scheduledAt: { gte: scrimNotPlayedCutoff(nowMs) },
                  },
                  {
                    status: SCRIM_STATUS.OPEN,
                    scheduledAt: { gte: new Date(nowMs) },
                  },
                ],
              },
            ],
          },
          orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
          take: 3,
          select: scrimSelect,
        })
      : Promise.resolve([]),
    prisma.scrim.findMany({
      where: { seasonId, status: SCRIM_STATUS.COMPLETED, OR: ours },
      orderBy: [{ scheduledAt: "desc" }, { id: "desc" }],
      select: scrimSelect,
    }),
  ]);
  if (!seasonActive && completed.length === 0) return null;

  const score = (scrim: (typeof completed)[number]) => {
    const hosts = scrim.hostTeamId === teamId;
    return {
      own: hosts ? scrim.hostScore : scrim.awayScore,
      other: hosts ? scrim.awayScore : scrim.hostScore,
    };
  };
  let won = 0;
  let drawn = 0;
  let lost = 0;
  for (const scrim of completed) {
    const { own, other } = score(scrim);
    if (own > other) won += 1;
    else if (own < other) lost += 1;
    else drawn += 1;
  }
  const opponentOf = (scrim: (typeof completed)[number]) =>
    scrim.hostTeamId === teamId
      ? (scrim.opponentTeam?.name ?? null)
      : scrim.hostTeam.name;

  return (
    <Card id="team-scrims" className="scroll-mt-40">
      <CardHeader
        title="Scrims"
        headingLevel={2}
        subtitle={
          completed.length > 0
            ? `Practice record ${won}-${drawn}-${lost} (won, drawn, lost) · never in the standings`
            : "Practice games against other league teams, never in the standings"
        }
        action={
          <Link
            href={`/scrims?season=${encodeURIComponent(seasonId)}`}
            className={textLink("text-sm")}
          >
            All scrims <LinkArrow />
          </Link>
        }
      />
      <CardBody className="space-y-4">
        {upcoming.length === 0 && completed.length === 0 ? (
          <EmptyState
            inline
            title="No scrims yet"
            description="Captains post practice times on Scrims, and another team claims one."
          />
        ) : null}
        {upcoming.length > 0 ? (
          <ul aria-label="Coming up" className="divide-y divide-line-soft text-sm">
            {upcoming.map((scrim) => {
              const opponent = opponentOf(scrim);
              const booked = scrim.status !== SCRIM_STATUS.OPEN;
              const { own, other } = score(scrim);
              return (
                <li
                  key={scrim.id}
                  className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 py-2"
                >
                  <span className="min-w-0 flex-1 basis-44">
                    <Link
                      href={`/scrims/${scrim.id}`}
                      className={textLink("font-medium [overflow-wrap:anywhere]")}
                    >
                      {opponent ? `vs ${opponent}` : "Open time, no opponent yet"}
                    </Link>
                    <span className="block text-xs text-muted">
                      <LocalTime
                        ts={scrim.scheduledAt.getTime()}
                        variant="short"
                        initial={formatLeagueMatchTime(scrim.scheduledAt, "short")}
                      />{" "}
                      · Best of {scrim.bestOf}
                    </span>
                  </span>
                  {scrim.status === SCRIM_STATUS.LIVE ? (
                    <Badge tone="accent">
                      Live · {own}–{other}
                    </Badge>
                  ) : booked ? (
                    <Badge tone="info">Booked</Badge>
                  ) : (
                    <Badge>Waiting for a team</Badge>
                  )}
                  {booked ? (
                    <Link
                      href={`/scrims/${scrim.id}#lobby`}
                      className={textLink("text-sm")}
                    >
                      Lobby setup <LinkArrow />
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        {completed.length > 0 ? (
          <div>
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
              Recent results
            </h3>
            <ul aria-label="Recent scrim results" className="divide-y divide-line-soft text-sm">
              {completed.slice(0, 3).map((scrim) => {
                const { own, other } = score(scrim);
                const outcome = own > other ? "W" : own < other ? "L" : "D";
                return (
                  <li key={scrim.id} className="py-1.5">
                    <Link
                      href={`/scrims/${scrim.id}`}
                      className="flex min-w-0 items-center justify-between gap-3 rounded-md transition-colors hover:text-info"
                    >
                      <span className="min-w-0 truncate">
                        vs {opponentOf(scrim) ?? "?"}
                      </span>
                      <span className="flex shrink-0 items-center gap-2 font-mono tabular-nums">
                        <Badge
                          tone={
                            outcome === "W"
                              ? "success"
                              : outcome === "L"
                                ? "danger"
                                : "neutral"
                          }
                        >
                          <span aria-hidden>{outcome}</span>
                          <span className="sr-only">
                            {outcome === "W" ? "Won" : outcome === "L" ? "Lost" : "Drawn"}
                          </span>
                        </Badge>
                        {own}–{other}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
