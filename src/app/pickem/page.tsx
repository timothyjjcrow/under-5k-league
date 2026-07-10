import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getActiveSeason } from "@/lib/season";
import { getSessionUser } from "@/lib/auth";
import { pickemStandings, pickSplit, predictionOpen } from "@/lib/pickem";
import { savePrediction } from "@/app/actions/pickem";
import { ActionForm, SubmitButton } from "@/components/action-form";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageTitle,
  PlayerLink,
  SectionTitle,
  TeamCrest,
} from "@/components/ui";
import { cn } from "@/lib/utils";

export const metadata = { title: "Pick'em" };

function fmtWhen(d: Date | null): string | null {
  if (!d) return null;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function PickemPage() {
  const season = await getActiveSeason();
  if (!season) {
    return (
      <div>
        <PageTitle title="Pick'em" />
        <EmptyState title="No active season" />
      </div>
    );
  }

  const viewer = await getSessionUser();
  const [matches, teams, predictions, users] = await Promise.all([
    prisma.match.findMany({
      where: { seasonId: season.id },
      orderBy: [{ week: "asc" }, { createdAt: "asc" }],
    }),
    prisma.team.findMany({ where: { seasonId: season.id } }),
    prisma.prediction.findMany({ where: { match: { seasonId: season.id } } }),
    prisma.user.findMany({
      where: { predictions: { some: { match: { seasonId: season.id } } } },
      select: { id: true, name: true, avatar: true },
    }),
  ]);

  if (matches.length === 0) {
    return (
      <div className="space-y-6">
        <PageTitle title="Pick'em" subtitle={season.name} />
        <EmptyState
          title="No matches to predict yet"
          description="Pick'em opens once the schedule is generated — call every winner, top the oracle board."
        />
      </div>
    );
  }

  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const userAvatar = new Map(users.map((u) => [u.id, u.avatar]));
  const myPicks = viewer
    ? new Map(
        predictions
          .filter((p) => p.userId === viewer.id)
          .map((p) => [p.matchId, p.pickedTeamId]),
      )
    : new Map<string, string>();

  const standings = pickemStandings(predictions, matches);
  const open = matches.filter((m) => predictionOpen(m));
  const graded = matches.filter(
    (m) => m.status === "COMPLETED" && m.winnerTeamId,
  );

  return (
    <div className="space-y-8">
      <PageTitle
        title="Pick'em"
        subtitle={`${season.name} · call every match, top the oracle board`}
        action={
          viewer ? null : (
            <Link href="/login" className="text-sm text-info hover:underline">
              Sign in to play →
            </Link>
          )
        }
      />

      {standings.length > 0 ? (
        <Card>
          <CardHeader
            title="Oracle board"
            subtitle={`${graded.length} decided match${graded.length === 1 ? "" : "es"} graded · draws void picks`}
          />
          <CardBody className="divide-y divide-line/60 p-0">
            {standings.map((s, i) => (
              <div
                key={s.userId}
                className="flex items-center gap-3 px-5 py-2.5 text-sm"
              >
                <span className="w-6 text-center text-muted">
                  {i === 0 ? "🔮" : i + 1}
                </span>
                <Avatar
                  name={userName.get(s.userId) ?? "?"}
                  src={userAvatar.get(s.userId) ?? null}
                  size={24}
                />
                <PlayerLink
                  userId={s.userId}
                  className="min-w-0 flex-1 truncate font-medium"
                >
                  {userName.get(s.userId) ?? "?"}
                </PlayerLink>
                <span className="font-mono text-xs tabular-nums text-muted">
                  {Math.round(s.accuracy * 100)}%
                </span>
                <span className="shrink-0 font-mono text-base font-semibold tabular-nums">
                  {s.correct}/{s.graded}
                </span>
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <section className="space-y-4">
        <SectionTitle
          aside={
            viewer
              ? "· picks lock at the match's scheduled start"
              : "· sign in to lock in your calls"
          }
        >
          Upcoming matches
        </SectionTitle>
        {open.length === 0 ? (
          <EmptyState
            title="Nothing open to predict"
            description="Every remaining match is locked or finished — check the oracle board."
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {open.map((m) => {
              const split = pickSplit(predictions, m.id, m.homeTeamId);
              const total = split.home + split.away;
              const myPick = myPicks.get(m.id);
              const side = (teamId: string, count: number) => {
                const name = teamName.get(teamId) ?? "?";
                const mine = myPick === teamId;
                return (
                  <ActionForm
                    action={savePrediction}
                    hidden={{ matchId: m.id, pickedTeamId: teamId }}
                    className="min-w-0 flex-1"
                  >
                    <SubmitButton
                      variant={mine ? "accent" : "secondary"}
                      size="sm"
                      className="w-full"
                      disabled={!viewer}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <TeamCrest
                          name={name}
                          seed={teamId}
                          size={20}
                          className="rounded"
                        />
                        <span className="truncate">{name}</span>
                        {mine ? <span aria-hidden>✓</span> : null}
                        {total > 0 ? (
                          <span className="ml-auto font-mono text-xs tabular-nums opacity-70">
                            {Math.round((count / total) * 100)}%
                          </span>
                        ) : null}
                      </span>
                    </SubmitButton>
                  </ActionForm>
                );
              };
              return (
                <Card key={m.id}>
                  <CardBody className="space-y-2.5">
                    <div className="flex items-center justify-between text-xs text-muted">
                      <span>
                        Week {m.week}
                        {m.phase !== "REGULAR" ? (
                          <Badge tone="accent" className="ml-2">
                            {m.phase === "FINAL" ? "Final" : "Playoff"}
                          </Badge>
                        ) : null}
                      </span>
                      <span className="flex items-center gap-2">
                        {fmtWhen(m.scheduledAt) ?? "time TBD"}
                        <Link
                          href={`/matches/${m.id}`}
                          className="text-info hover:underline"
                        >
                          preview →
                        </Link>
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {side(m.homeTeamId, split.home)}
                      <span className="shrink-0 text-xs text-muted">vs</span>
                      {side(m.awayTeamId, split.away)}
                    </div>
                    {total > 0 ? (
                      <div className="text-center text-[11px] text-muted">
                        {total} pick{total === 1 ? "" : "s"} in
                      </div>
                    ) : null}
                  </CardBody>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {graded.length > 0 && viewer ? (
        <section className="space-y-4">
          <SectionTitle>Your graded picks</SectionTitle>
          <Card>
            <CardBody className="divide-y divide-line/60 p-0">
              {graded
                .filter((m) => myPicks.has(m.id))
                .map((m) => {
                  const pick = myPicks.get(m.id)!;
                  const right = pick === m.winnerTeamId;
                  return (
                    <div
                      key={m.id}
                      className="flex items-center gap-3 px-5 py-2.5 text-sm"
                    >
                      <span aria-hidden>{right ? "✅" : "❌"}</span>
                      <span className="min-w-0 flex-1 truncate">
                        Week {m.week}: {teamName.get(m.homeTeamId)}{" "}
                        <span className="font-mono text-xs">
                          {m.homeScore}–{m.awayScore}
                        </span>{" "}
                        {teamName.get(m.awayTeamId)}
                      </span>
                      <span className="shrink-0 text-xs text-muted">
                        you picked {teamName.get(pick)}
                      </span>
                    </div>
                  );
                })}
            </CardBody>
          </Card>
        </section>
      ) : null}
    </div>
  );
}
