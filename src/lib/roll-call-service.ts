// Storage for the roll call (rules: roll-call.ts): who is expected to answer,
// their answers, and the season's open switch (Season.rollCallOpenedAt,
// written by the admin actions in admin-season.ts).
//
// Rivals: an answer is the player's own row, and nothing else depends on it.
// What the answer action checks first (the roll call is up, the night is the
// one the page showed, the player is on the list) can change before the
// write lands, and none of it needs a guard: every read re-derives it. An
// admin who closes the roll call meanwhile leaves one more true answer in a
// closed roll call. A night moved meanwhile leaves an answer that names the
// old night, which stops counting and asks the player again. A player who
// withdraws meanwhile leaves a row that counts only if they sign up again.
// Two taps by one player meet at the primary key, and the second rewrites
// the same row.

import type { Prisma, Season } from "@prisma/client";
import { REGISTRATION_STATUS, REGISTRATION_TYPE } from "./constants";
import { LEAGUE_CONFIG } from "./league-config";
import { announcedMatchNight, pollDecidesMatchNight } from "./match-night";
import { nextSlotOccurrence } from "./match-night-poll";
import { matchNightPollOpen } from "./match-night-poll-service";
import { prisma } from "./prisma";
import { isUniqueViolation } from "./prisma-errors";
import {
  buildRollCallView,
  parseMatchNight,
  rollCallCannotOpen,
  rollCallLive,
  sameMatchNight,
  type RollCallPlayer,
  type RollCallView,
} from "./roll-call";
import { getActiveSeason } from "./season";
import { UserFacingError } from "./user-facing-error";
import { LEAGUE_LOCALE } from "./zoned-time";

type Db = Pick<Prisma.TransactionClient, "registration" | "teamMember" | "team">;

const PLAYER_FIELDS = { id: true, name: true, avatar: true } as const;

/**
 * Everyone the roll call expects an answer from: every active full-player
 * signup (the draft pool), plus captains and roster seats. Standins are not
 * on it: nobody drafts them, so "for whichever team drafts me" isn't theirs
 * to promise, the way only full players confirm the draft time
 * (owedDraftConfirmation).
 */
async function rollCallRoster(db: Db, seasonId: string): Promise<RollCallPlayer[]> {
  const [registrations, members, captains] = await Promise.all([
    db.registration.findMany({
      where: {
        seasonId,
        status: REGISTRATION_STATUS.ACTIVE,
        type: REGISTRATION_TYPE.PLAYER,
      },
      select: { user: { select: PLAYER_FIELDS } },
    }),
    db.teamMember.findMany({
      where: { seasonId },
      select: { user: { select: PLAYER_FIELDS } },
    }),
    db.team.findMany({
      where: { seasonId, withdrawn: false },
      select: { captain: { select: PLAYER_FIELDS } },
    }),
  ]);
  const players = new Map<string, RollCallPlayer>();
  for (const player of [
    ...registrations.map((r) => r.user),
    ...members.map((m) => m.user),
    ...captains.map((t) => t.captain),
  ]) {
    players.set(player.id, player);
  }
  return [...players.values()];
}

/** Whether one player is on the roll call (rollCallRoster, for one id). */
async function onRollCall(db: Db, seasonId: string, userId: string): Promise<boolean> {
  const [registration, member, captain] = await Promise.all([
    db.registration.findFirst({
      where: {
        seasonId,
        userId,
        status: REGISTRATION_STATUS.ACTIVE,
        type: REGISTRATION_TYPE.PLAYER,
      },
      select: { id: true },
    }),
    db.teamMember.findFirst({ where: { seasonId, userId }, select: { id: true } }),
    db.team.findFirst({
      where: { seasonId, captainId: userId, withdrawn: false },
      select: { id: true },
    }),
  ]);
  return !!(registration || member || captain);
}

type RollCallState = {
  season: Season;
  /** The season's night as pages print it, or null when none is announced. */
  night: string | null;
  pollDecidesNight: boolean;
  live: boolean;
};

/**
 * The active season's roll call as the rules see it: its night (from the
 * fixtures once any has a kickoff, else the season's text, as every page
 * prints it) and whether it is up. Null with no active season.
 */
async function readRollCallState(): Promise<RollCallState | null> {
  const season = await getActiveSeason();
  if (!season) return null;
  const [fixtures, pollOpen] = await Promise.all([
    prisma.match.findMany({
      where: { seasonId: season.id },
      select: { scheduledAt: true, status: true },
    }),
    matchNightPollOpen(),
  ]);
  const night = announcedMatchNight(season, fixtures);
  const pollDecidesNight = pollDecidesMatchNight(season, fixtures, pollOpen);
  return {
    season,
    night,
    pollDecidesNight,
    live: rollCallLive({
      status: season.status,
      openedAt: season.rollCallOpenedAt,
      night,
      pollDecidesNight,
    }),
  };
}

/**
 * The instant a viewer's clock is read to convert the night: the first
 * match night after the draft (or after now, once the draft time has
 * passed), so a player sees the time they will actually play once daylight
 * saving has moved. Now, for a night that doesn't read as one.
 */
function firstNightAt(night: string, season: Pick<Season, "draftAt">, nowMs: number): number {
  const slot = parseMatchNight(night, LEAGUE_CONFIG.timeZone, LEAGUE_LOCALE);
  if (!slot) return nowMs;
  const from = Math.max(nowMs, season.draftAt?.getTime() ?? 0);
  return nextSlotOccurrence(slot, from, LEAGUE_CONFIG.timeZone);
}

async function viewOf(
  state: RollCallState & { night: string },
  viewerId: string | null,
  nowMs: number,
): Promise<RollCallView> {
  const [players, answers] = await Promise.all([
    rollCallRoster(prisma, state.season.id),
    prisma.rollCallAnswer.findMany({
      where: { seasonId: state.season.id },
      select: { userId: true, matchNight: true, answeredAt: true },
    }),
  ]);
  return buildRollCallView({
    seasonName: state.season.name,
    status: state.season.status,
    night: state.night,
    timeZone: LEAGUE_CONFIG.timeZone,
    locale: LEAGUE_LOCALE,
    nowMs,
    clockAt: firstNightAt(state.night, state.season, nowMs),
    players,
    answers,
    viewerId,
  });
}

/**
 * Home's roll call: the view while it is up, else null (the card renders
 * nothing). A closed roll call costs Home the active-season read it already
 * makes and nothing more.
 */
export async function loadHomeRollCall(
  viewer: { id: string } | null,
  nowMs: number,
): Promise<RollCallView | null> {
  const season = await getActiveSeason();
  if (!season?.rollCallOpenedAt) return null;
  const state = await readRollCallState();
  if (!state?.live || !state.night) return null;
  return viewOf({ ...state, night: state.night }, viewer?.id ?? null, nowMs);
}

/** The roll call as /admin's section shows it, open or closed. */
export type AdminRollCall = {
  seasonId: string;
  /** For the stale-form claim (renderedSeasonClaim). */
  seasonUpdatedAt: Date;
  open: boolean;
  openedAtMs: number | null;
  /** Up on Home right now (open, and its phase and night allow it). */
  live: boolean;
  /** Why it can't be opened now, or null when it can (rollCallCannotOpen). */
  cannotOpen: string | null;
  /** Who is in and who isn't, whenever the season has a night to read. */
  view: RollCallView | null;
  /**
   * The players still to answer as Discord mentions, for the admin to paste
   * into a channel: `<@id>` for a linked account, else the typed handle,
   * else the site name. Admin-only: it carries Discord ids and handles.
   */
  waitingMentions: string;
};

export async function loadAdminRollCall(nowMs: number): Promise<AdminRollCall | null> {
  const state = await readRollCallState();
  if (!state) return null;
  const { season } = state;
  const view = state.night
    ? await viewOf({ ...state, night: state.night }, null, nowMs)
    : null;
  return {
    seasonId: season.id,
    seasonUpdatedAt: season.updatedAt,
    open: season.rollCallOpenedAt != null,
    openedAtMs: season.rollCallOpenedAt?.getTime() ?? null,
    live: state.live,
    cannotOpen: rollCallCannotOpen({
      status: season.status,
      night: state.night,
      pollDecidesNight: state.pollDecidesNight,
    }),
    view,
    waitingMentions: await mentionsOf(view?.waiting ?? []),
  };
}

async function mentionsOf(players: readonly RollCallPlayer[]): Promise<string> {
  if (players.length === 0) return "";
  const contacts = await prisma.user.findMany({
    where: { id: { in: players.map((p) => p.id) } },
    select: { id: true, discordId: true, discordName: true },
  });
  const byId = new Map(contacts.map((c) => [c.id, c]));
  return players
    .map((player) => {
      const contact = byId.get(player.id);
      if (contact?.discordId) return `<@${contact.discordId}>`;
      if (contact?.discordName) return `@${contact.discordName}`;
      return player.name;
    })
    .join(" ");
}

/**
 * Whether the admin may open the active season's roll call now: null when
 * they may, else the refusal (rollCallCannotOpen). The open action asks this
 * before it writes; a night or phase that changes after it only hides the
 * card again (rollCallLive).
 */
export async function rollCallOpenRefusal(): Promise<string | null> {
  const state = await readRollCallState();
  if (!state) return "There is no active season.";
  return rollCallCannotOpen({
    status: state.season.status,
    night: state.night,
    pollDecidesNight: state.pollDecidesNight,
  });
}

/**
 * "I'm in": the player can play the night the card showed (`seenNight`)
 * every week and will play for whichever team drafts them. Refused unless
 * the roll call is up, the night is still the one they saw, and they are on
 * the list. Stores the night as the season prints it now, so the answer
 * counts until the night moves.
 */
export async function answerRollCall(input: {
  userId: string;
  seenNight: string;
}): Promise<{ outcome: "in" | "already-in" | "renewed"; night: string }> {
  const state = await readRollCallState();
  if (!state?.live || !state.night) {
    throw new UserFacingError("The roll call is closed.");
  }
  const { season, night } = state;
  const sameNight = (text: string) =>
    sameMatchNight(text, night, LEAGUE_CONFIG.timeZone, LEAGUE_LOCALE);
  if (!sameNight(input.seenNight)) {
    throw new UserFacingError(
      `Match night changed since this page loaded: it's now ${night}. Reload and check it before you lock in.`,
    );
  }
  if (!(await onRollCall(prisma, season.id, input.userId))) {
    throw new UserFacingError(
      "The roll call is for players signed up for the draft. Sign up on My account first.",
    );
  }
  const key = { seasonId_userId: { seasonId: season.id, userId: input.userId } };
  const existing = await prisma.rollCallAnswer.findUnique({
    where: key,
    select: { matchNight: true },
  });
  if (existing && sameNight(existing.matchNight)) {
    return { outcome: "already-in", night };
  }
  const write = () =>
    prisma.rollCallAnswer.upsert({
      where: key,
      create: { seasonId: season.id, userId: input.userId, matchNight: night },
      update: { matchNight: night, answeredAt: new Date() },
    });
  try {
    await write();
  } catch (error) {
    // A second tap created the row between this one's read and its insert:
    // the row exists now, so the retry updates it.
    if (!isUniqueViolation(error)) throw error;
    await write();
  }
  return { outcome: existing ? "renewed" : "in", night };
}

/**
 * Take back an "I'm in". Cleanup stays legal whatever state the roll call is
 * in, so a player can always undo what they said.
 */
export async function takeBackRollCall(input: {
  userId: string;
}): Promise<{ outcome: "out" | "already-out" }> {
  const season = await getActiveSeason();
  if (!season) return { outcome: "already-out" };
  const { count } = await prisma.rollCallAnswer.deleteMany({
    where: { seasonId: season.id, userId: input.userId },
  });
  return { outcome: count > 0 ? "out" : "already-out" };
}
