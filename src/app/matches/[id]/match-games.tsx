import { prisma } from "@/lib/prisma";
import { gameMvp } from "@/lib/achievements";
import { AutoOpenDetails } from "@/components/auto-open-details";
import { GameIdentityEditor } from "@/components/game-identity-editor";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  LinkArrow,
  textLink,
} from "@/components/ui";
import { NetWorthAdvantage, SidePlayers } from "./box-score";
import type { MatchPageGame, MatchPageMatch, MatchViewer } from "./load";

/**
 * One card per played game: Game 1's box score open, later games folded to
 * their result line. Each card's id is the scoreboard's Game chip target.
 */
export async function MatchGames({
  match,
  games,
  viewer,
}: {
  match: MatchPageMatch;
  games: MatchPageGame[];
  viewer: MatchViewer;
}) {
  const userIds = [
    ...new Set(
      games.flatMap((g) => g.parsed.map((p) => p.userId).filter(Boolean)),
    ),
  ] as string[];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } } })
    : [];
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const userAvatar = new Map(users.map((u) => [u.id, u.avatar]));
  const teamName = new Map([
    [match.homeTeamId, match.homeTeam.name],
    [match.awayTeamId, match.awayTeam.name],
  ]);
  return (
    <>
      {games.map((g, i) => {
        const radiant = g.parsed.filter((p) => p.isRadiant);
        const dire = g.parsed.filter((p) => !p.isRadiant);
        const winnerName = g.winnerTeamId
          ? teamName.get(g.winnerTeamId)
          : null;
        const radiantName = g.radiantTeamId
          ? (teamName.get(g.radiantTeamId) ?? "Radiant")
          : "Radiant";
        const direName = g.direTeamId
          ? (teamName.get(g.direTeamId) ?? "Dire")
          : "Dire";
        const maxNet = Math.max(1, ...g.parsed.map((p) => p.netWorth ?? 0));
        const mvpId = gameMvp(g.parsed, g.radiantWin);
        const radiantNet = radiant.reduce(
          (s, p) => s + (p.netWorth ?? 0),
          0,
        );
        const direNet = dire.reduce((s, p) => s + (p.netWorth ?? 0), 0);
        // 0s / 0-0 means the header stats never got reported — showing
        // "0m 0s · 0-0 kills" reads as a real (absurd) game.
        const gameLine =
          [
            g.durationSecs > 0
              ? `${Math.floor(g.durationSecs / 60)}m ${g.durationSecs % 60}s`
              : null,
            g.radiantScore + g.direScore > 0
              ? `${g.radiantScore}-${g.direScore} kills`
              : null,
          ]
            .filter(Boolean)
            .join(" · ") || undefined;
        const openDota = (
          <a
            href={`https://www.opendota.com/matches/${g.dotaMatchId}`}
            target="_blank"
            rel="noreferrer"
            className={textLink("whitespace-nowrap text-xs")}
          >
            OpenDota <LinkArrow out />
          </a>
        );
        const boxScore = (
          <>
            <CardBody className="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
              <NetWorthAdvantage
                radiantName={radiantName}
                direName={direName}
                radiantNet={radiantNet}
                direNet={direNet}
              />
              <SidePlayers
                label={radiantName}
                win={g.radiantWin}
                mvpId={mvpId}
                players={radiant}
                userName={userName}
                userAvatar={userAvatar}
                maxNet={maxNet}
              />
              <SidePlayers
                label={direName}
                win={!g.radiantWin}
                mvpId={mvpId}
                players={dire}
                userName={userName}
                userAvatar={userAvatar}
                maxNet={maxNet}
              />
            </CardBody>
            {viewer?.role === "ADMIN" ? <GameIdentityEditor gameId={g.id} /> : null}
          </>
        );
        if (i === 0) {
          return (
            <Card
              key={g.id}
              id={`game-${g.id}`}
              className="scroll-mt-24 overflow-hidden"
            >
              <CardHeader
                title={`Game ${i + 1}`}
                headingLevel={2}
                subtitle={gameLine}
                action={
                  <div className="flex items-center gap-2">
                    {winnerName ? (
                      <Badge tone="success">{winnerName} won</Badge>
                    ) : null}
                    {openDota}
                  </div>
                }
              />
              {boxScore}
            </Card>
          );
        }
        // Later games fold to their result line, as /inhouse does: a
        // full box score is about 1,760px on a phone, so an open Bo3 was
        // 7,000px. The id stays on the <details>, and a jump from the
        // scoreboard's Game chips (or a shared #game- link) opens it.
        return (
          <Card key={g.id} className="overflow-hidden">
            <AutoOpenDetails
              id={`game-${g.id}`}
              className="group/game scroll-mt-24"
            >
              <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-surface-2/40 [&::-webkit-details-marker]:hidden">
                <div className="min-w-0 flex-1 basis-48">
                  {/* Sized like a CardHeader title, as Game 1's is. */}
                  <h2 className="text-[0.9375rem] font-semibold leading-snug text-fg">
                    Game {i + 1}
                  </h2>
                  {gameLine ? (
                    <p className="mt-0.5 text-[13px] text-muted">{gameLine}</p>
                  ) : null}
                </div>
                <span className="flex min-w-0 items-center gap-3">
                  {winnerName ? (
                    <Badge tone="success">{winnerName} won</Badge>
                  ) : null}
                  <span
                    aria-hidden
                    className="text-muted transition-transform group-open/game:rotate-180 motion-reduce:transition-none"
                  >
                    ▾
                  </span>
                </span>
              </summary>
              <div className="border-t border-line-soft">
                <p className="flex justify-end px-4 pt-3">{openDota}</p>
                {boxScore}
              </div>
            </AutoOpenDetails>
          </Card>
        );
      })}
    </>
  );
}
