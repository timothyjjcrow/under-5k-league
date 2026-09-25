import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { decodeIndexedGamePlayers } from "@/lib/player-stats";
import { gamePlayersDigest } from "@/lib/game-participants";
import { correctGameIdentityAction } from "@/app/actions/game-participants";
import { ActionForm, SubmitButton } from "./action-form";
import { heroById } from "@/lib/heroes";

export async function GameIdentityEditor({ gameId }: { gameId: string }) {
  const viewer = await getSessionUser();
  if (viewer?.role !== "ADMIN") return null;
  const game = await prisma.game.findUnique({ where: { id: gameId }, include: {
    match: { select: { seasonId: true, homeTeam: { select: { id: true, name: true } }, awayTeam: { select: { id: true, name: true } } } },
  } });
  if (!game) return null;
  const decoded = decodeIndexedGamePlayers(game.players);
  const mappedIds = decoded.players.flatMap((line) => line.userId ? [line.userId] : []);
  const users = await prisma.user.findMany({
    where: { OR: [
      { registrations: { some: { seasonId: game.match.seasonId } } },
      { teamMemberships: { some: { seasonId: game.match.seasonId } } },
      { id: { in: mappedIds } },
    ] }, select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  const teams = [game.match.homeTeam, game.match.awayTeam];
  const digest = gamePlayersDigest(game.players);
  return <details className="m-4 rounded-lg border border-line p-3">
    <summary className="cursor-pointer py-1 text-sm font-semibold">Correct player attribution · Admin</summary>
    <p className="my-3 text-xs text-muted">Use the replay and observed Dota account to identify an unmapped or incorrectly mapped player. Statistics and the recorded side stay unchanged. Each correction needs a reason and is retained in the admin audit.</p>
    <div className="space-y-3">
      {decoded.indexed.map(({ sourceLineIndex, player }) => {
        const sideId = player.isRadiant ? game.radiantTeamId : game.direTeamId;
        const side = teams.find((team) => team.id === sideId);
        return <ActionForm key={`${digest}:${sourceLineIndex}`} action={correctGameIdentityAction}
          className="grid gap-2 rounded border border-line-soft p-3 text-sm sm:grid-cols-2"
          hidden={{ gameId, sourceLineIndex: String(sourceLineIndex), expectedSourceDigest: digest }}>
          <p className="sm:col-span-2 font-medium">Line {sourceLineIndex + 1}: {heroById(player.heroId)?.name ?? `Hero ${player.heroId}`} · {player.isRadiant ? "Radiant" : "Dire"} · Dota account {player.accountId ?? "unknown"}</p>
          <label className="space-y-1"><span>League player</span><select name="userId" defaultValue={player.userId ?? ""} className="w-full rounded border border-line bg-bg p-2">
            <option value="">Unknown player</option>
            {users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
          </select></label>
          <label className="space-y-1"><span>Recorded team</span><select name="teamId" defaultValue={player.teamId === sideId ? player.teamId ?? "" : ""} className="w-full rounded border border-line bg-bg p-2">
            <option value="">Unknown team</option>
            {side ? <option value={side.id}>{side.name}</option> : null}
          </select></label>
          <label className="space-y-1 sm:col-span-2"><span>Evidence / reason</span><input name="reason" required maxLength={300} className="w-full rounded border border-line bg-bg p-2" placeholder="What confirms this identity?" /></label>
          <SubmitButton size="sm">Save attribution correction</SubmitButton>
        </ActionForm>;
      })}
    </div>
  </details>;
}
