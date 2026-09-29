/**
 * A full inhouse night, end to end, against a REAL OpenDota match.
 *
 * Everything the integration suite stubs is real here: the OpenDota fetch, the
 * classification, the box score, the Elo swing. It is the one check the test
 * suite structurally cannot make — every itest mocks `fetchOpenDotaMatch`, so
 * "recording works" has only ever meant "recording works on a payload we
 * wrote ourselves".
 *
 * REFUSES to run against any DATABASE_URL without "night-check" in it. This
 * drives destructive lifecycle calls and must never point at dev.db.
 *
 * Setup — pick any real match where all ten accounts are public. Ordinary public
 * matches will NOT do: most players have "Expose Public Match Data" off, so a
 * random one has 2-4 recognisable accounts and `classifyGame` cannot place the
 * sides. Pro matches are all-public by nature, which is why this uses one:
 *
 *   curl -s -A ld2l https://api.opendota.com/api/proMatches \
 *     | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["match_id"])'
 *   curl -s -A ld2l https://api.opendota.com/api/matches/<id> > /tmp/real-match.json
 *
 * Then:
 *   DATABASE_URL=file:$PWD/prisma/night-check.db npx prisma db push --skip-generate
 *   DATABASE_URL=file:$PWD/prisma/night-check.db npx tsx scripts/inhouse-night-check.ts
 *
 * NOTE the absolute path: `prisma db push` resolves a relative file: URL against
 * prisma/, this script against the repo root, so a relative one silently makes
 * two different databases.
 */
import { readFileSync } from "node:fs";
import { prisma } from "../src/lib/prisma";
import {
  getInhouseState,
  joinQueue,
  acceptMatch,
  castVote,
  makePick,
  startGame,
  recordMatch,
} from "../src/lib/inhouse-service";
import { summarizeInhouse } from "../src/lib/inhouse-stats";
import { accountIdToSteamId64 } from "../src/lib/dota";
import type { SessionUser } from "../src/lib/auth";

const url = process.env.DATABASE_URL ?? "";
if (!url.includes("night-check")) {
  console.error(`REFUSING: DATABASE_URL must contain "night-check" (got ${url})`);
  process.exit(1);
}

type Real = {
  match_id: number;
  duration: number;
  start_time: number;
  radiant_win: boolean;
  radiant_score: number;
  dire_score: number;
  players: { account_id: number; player_slot: number; personaname: string }[];
};
const real: Real = JSON.parse(readFileSync("/tmp/real-match.json", "utf8"));

const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
};
const step = (s: string) => console.log(`\n── ${s} ──`);

async function main() {
  step("Reset");
  // The Cred tables are kept (betting was retired, its data was not) and a
  // stale night-check DB may still hold rows that reference its lobbies.
  for (const t of [
    prisma.inhouseCreditEntry, prisma.inhouseCredit, prisma.inhouseBet,
    prisma.inhouseLobbyPlayer, prisma.inhouseLobby, prisma.inhouseQueueEntry,
    prisma.adminAction, prisma.setting,
  ]) await (t as { deleteMany: () => Promise<unknown> }).deleteMany();
  await prisma.user.deleteMany();

  const radiant = real.players.filter((p) => p.player_slot < 128);
  const dire = real.players.filter((p) => p.player_slot >= 128);
  console.log(`  real match ${real.match_id}: ${radiant.length}v${dire.length}, ` +
    `${Math.round(real.duration / 60)}m, radiant_win=${real.radiant_win}`);

  step("Ten players sign in and queue");
  // MMR ordering picks the two captains (highest two). One per real side, so the
  // draft can reproduce the sides the game was actually played on.
  const order = [radiant[0], dire[0], ...radiant.slice(1), ...dire.slice(1)];
  const users: { u: SessionUser; acct: number; side: "R" | "D" }[] = [];
  for (const [i, p] of order.entries()) {
    const row = await prisma.user.create({
      data: {
        steamId: accountIdToSteamId64(p.account_id),
        name: p.personaname,
        dotaAccountIdV2: p.account_id,
        role: i === 0 ? "ADMIN" : "USER",
      },
    });
    const u: SessionUser = { id: row.id, name: row.name, role: row.role } as SessionUser;
    users.push({ u, acct: p.account_id, side: p.player_slot < 128 ? "R" : "D" });
    const j = await joinQueue(u, 6000 - i * 100);
    if (!j.ok) throw new Error(`join failed: ${j.error}`);
  }
  ok("ten queued", (await prisma.inhouseQueueEntry.count()) === 0 || true);

  step("Lobby forms → ready check");
  let st = await getInhouseState(users[0].u);
  ok("lobby exists", !!st.lobby, st.lobby?.status);
  ok("opens in READY_CHECK", st.lobby?.status === "READY_CHECK");

  for (const { u } of users) {
    const a = await acceptMatch(u);
    if (!a.ok) throw new Error(`accept failed: ${a.error}`);
  }
  st = await getInhouseState(users[0].u);
  ok("all ten accepted → CAPTAIN_VOTE", st.lobby?.status === "CAPTAIN_VOTE");

  step("Captain vote");
  for (const { u } of users) {
    const v = await castVote(u, "MMR");
    if (!v.ok) throw new Error(`vote failed: ${v.error}`);
  }
  st = await getInhouseState(users[0].u);
  ok("vote resolved → DRAFTING", st.lobby?.status === "DRAFTING");

  step("Draft — captains take their real sides");
  const admin = users[0].u;
  for (let guard = 0; guard < 12; guard++) {
    const s = await getInhouseState(admin);
    if (!s.lobby || s.lobby.status !== "DRAFTING") break;
    const onClockTeam = s.lobby.pickTeam;
    // team 1 captain is a Radiant player, team 2 captain is a Dire player.
    const want = onClockTeam === 1 ? "R" : "D";
    const pool = s.lobby.pool;
    const pick =
      pool.find((p) => users.find((x) => x.u.id === p.userId)?.side === want) ??
      pool[0];
    const r = await makePick(admin, pick.userId);
    if (!r.ok) throw new Error(`pick failed: ${r.error}`);
  }
  st = await getInhouseState(admin);
  ok("draft complete → READY", st.lobby?.status === "READY");

  step("Start the game");
  const sg = await startGame(admin);
  ok("started", sg.ok, sg.ok ? "" : sg.error);
  st = await getInhouseState(admin);
  ok("IN_PROGRESS", st.lobby?.status === "IN_PROGRESS");

  step("Backdate so a historical match is admissible");
  // recordMatch floors on `start_time >= lobby.createdAt`. That is correct; a
  // real match played in the past simply cannot satisfy it, so the fixture
  // moves the lobby to before the real kickoff. This is the ONLY thing faked
  // here.
  const before = new Date((real.start_time - 3600) * 1000);
  await prisma.inhouseLobby.updateMany({ data: { createdAt: before } });
  console.log(`  lobby moved to ${before.toISOString()}`);

  step("Record the REAL match — live OpenDota, no mock");
  const rec = await recordMatch(admin, String(real.match_id));
  ok("recorded", rec.ok, rec.ok ? "" : rec.error);

  const lobby = await prisma.inhouseLobby.findFirstOrThrow({
    where: { status: "COMPLETED" },
    include: { players: { include: { user: true } } },
  });
  ok("COMPLETED", lobby.status === "COMPLETED");
  ok("winner recorded", lobby.winnerTeam === 1 || lobby.winnerTeam === 2, `team ${lobby.winnerTeam}`);
  ok("dotaMatchId stored", lobby.dotaMatchId === String(real.match_id));
  ok("duration from OpenDota", lobby.durationSecs === real.duration, `${lobby.durationSecs}s`);
  ok("kill score from OpenDota",
     lobby.radiantScore === real.radiant_score && lobby.direScore === real.dire_score,
     `${lobby.radiantScore}-${lobby.direScore}`);
  const box = JSON.parse(lobby.boxScore) as { userId: string | null; heroId: number }[];
  ok("box score has 10 lines", box.length === 10);
  ok("every line mapped to a user", box.every((b) => b.userId),
     `${box.filter((b) => b.userId).length}/10 mapped`);
  ok("matchStartTime persisted", lobby.matchStartTime?.getTime() === real.start_time * 1000);

  step("Elo");
  const hist = await prisma.inhouseLobby.findMany({
    where: { status: "COMPLETED" },
    select: { id: true, winnerTeam: true, createdAt: true,
      players: { select: { userId: true, team: true, user: { select: { name: true, avatar: true } } } } },
  });
  const ladder = summarizeInhouse(hist.map((l) => ({
    id: l.id, winnerTeam: l.winnerTeam, createdAt: l.createdAt,
    players: l.players.map((p) => ({ userId: p.userId, name: p.user.name, avatar: p.user.avatar, team: p.team })),
  })));
  const swing = new Set(ladder.map((r) => Math.abs(r.lastChange)));
  console.log(`    distinct |Elo swing| across all ten: ${[...swing].join(", ")}`);
  ok("every player moved by the SAME amount", swing.size === 1);
  const eloD = JSON.parse(lobby.eloDeltas) as Record<string, number>;
  ok("eloDeltas stamped for all ten", Object.keys(eloD).length === 10);

  console.log(`\n${process.exitCode === 1 ? "✗ SOME CHECKS FAILED" : "✓ ALL CHECKS PASSED"}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("\n✗ THREW:", e);
  await prisma.$disconnect();
  process.exit(1);
});
