// The smurf check (Tim, 2026-11-27): when a player first joins, a league
// signup or their first inhouse, their Dota account is read for obvious
// signs of a smurf, and a flagged account waits for an admin, the way a
// medal over the line does (medal-approval.ts). The admin approves at an
// MMR they set, the fix for an underrated account, or declines.
//
// Pure: every signal reads the player's stored OpenDota snapshot
// (`User.pubStats`, pub-stats.ts) and medal, never a live call, so the
// signup, the inhouse join and the pages that show the card all judge the
// same facts. No visible match data is unknown, and unknown never flags
// anyone. Rules: docs/features/players-and-registration.md ("Smurf check").

import { REGISTRATION_STATUS } from "./constants";
import { pubLobbyRead, medalMidMmr } from "./pub-scout";
import { parsePubStats, type PubStats } from "./pub-stats";
import { rankMedalName, rankMedalTier } from "./rank";

/** A fixed locale, so a line reads "1,100" on every server. */
const MMR_FORMAT = new Intl.NumberFormat("en-US");

/**
 * The fewest games an account should have for its medal. Calibrated
 * (2026-11-27) on every stored US and Europe snapshot: under these, 13 of
 * 219 US and 8 of 87 Europe accounts with visible games, nearly all of them
 * players an earlier review had already called a suspect or an admin had
 * removed. A young account whose medal matches its lobbies and wins half
 * its games is no problem; a young account already at a high medal is the
 * classic second account.
 */
export function smurfMinGames(rankTier: number | null | undefined): number {
  const medal = rankMedalTier(rankTier);
  if (medal >= 7) return 800; // Divine and Immortal
  if (medal === 6) return 500; // Ancient
  if (medal === 5) return 300; // Legend
  return 150; // no medal to Archon: a brand-new account
}

/** Wins in their newest 20 matchmaking games that flag a climbing account.
 *  A player who wins half their games reaches 17 about once in 750 tries;
 *  no stored account did (the hottest was 16, a veteran). */
export const SMURF_WIN_STREAK_WINS = 17;
const STREAK_GAMES = 20;

/** How far their ranked lobbies may sit above their medal's middle. More
 *  than a whole medal: party play and a lagging medal stay well under it
 *  (no stored account came within 800). */
export const SMURF_LOBBY_GAP_MMR = 1000;
/** Lobbies played mostly in a party say more about the party: past this
 *  share of their games the lobby isn't judged. */
const SOLO_PARTY_SHARE_MAX = 0.5;

export type SmurfSignalKey = "young-account" | "win-streak" | "lobby-above-medal";

/** One finding, in a neutral line both the player and the admins read. */
export type SmurfSignal = { key: SmurfSignalKey; line: string };

/**
 * What the check finds on an account, from its snapshot and medal. Empty
 * when nothing is wrong or nothing is known: no snapshot, or one with no
 * visible games (match data private, or no games), says nothing either way.
 */
export function smurfSignals({
  pub,
  rankTier,
}: {
  pub: PubStats | null | undefined;
  rankTier: number | null | undefined;
}): SmurfSignal[] {
  if (!pub) return [];
  const signals: SmurfSignal[] = [];
  const medal = rankMedalTier(rankTier) > 0 ? rankMedalName(rankTier) : null;

  const games = pub.totalGames;
  if (games > 0 && games < smurfMinGames(rankTier)) {
    const count = `${MMR_FORMAT.format(games)} ${games === 1 ? "game" : "games"}`;
    signals.push({
      key: "young-account",
      line: medal
        ? `only ${count} on the account, few for a ${medal} medal`
        : `only ${count} on the account`,
    });
  }

  const scout = pub.scout;
  if (scout) {
    const decided = scout.recentWins + scout.recentLosses;
    if (decided >= STREAK_GAMES && scout.recentWins >= SMURF_WIN_STREAK_WINS) {
      signals.push({
        key: "win-streak",
        line: `won ${scout.recentWins} of the last ${decided} matchmaking games`,
      });
    }

    const lobby = pubLobbyRead(scout);
    const middle = medalMidMmr(rankTier);
    const partyShare = scout.partyKnown > 0 ? scout.party / scout.partyKnown : 0;
    if (
      lobby &&
      lobby.ranked &&
      medal &&
      middle != null &&
      partyShare <= SOLO_PARTY_SHARE_MAX &&
      lobby.mmr - middle >= SMURF_LOBBY_GAP_MMR
    ) {
      signals.push({
        key: "lobby-above-medal",
        line: `ranked games average about ${MMR_FORMAT.format(lobby.mmr)} MMR, ${MMR_FORMAT.format(Math.round((lobby.mmr - middle) / 50) * 50)} above a ${medal} medal`,
      });
    }
  }
  return signals;
}

/** The signals for a stored snapshot, as the gates read it: a blob that
 *  won't parse is no snapshot, so it flags nobody. */
export function smurfSignalsFromStored(
  pubStats: string | null | undefined,
  rankTier: number | null | undefined,
): SmurfSignal[] {
  return smurfSignals({ pub: parsePubStats(pubStats), rankTier });
}

/** The findings as one phrase: "a; b and c". */
export function smurfSignalPhrase(signals: readonly SmurfSignal[]): string {
  const lines = signals.map((s) => s.line);
  if (lines.length <= 1) return lines.join("");
  return `${lines.slice(0, -1).join("; ")} and ${lines[lines.length - 1]}`;
}

/** The findings stored on the player's request, so the admin reads what
 *  the check found when they asked, whatever it finds later. */
export function serializeSmurfSignals(signals: readonly SmurfSignal[]): string {
  return signals.length ? JSON.stringify(signals.map(({ key, line }) => ({ key, line }))) : "";
}

const SIGNAL_KEYS: ReadonlySet<string> = new Set<SmurfSignalKey>([
  "young-account",
  "win-streak",
  "lobby-above-medal",
]);

/** A request's stored findings; garbage reads as none. */
export function parseSmurfSignals(raw: string | null | undefined): SmurfSignal[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data.flatMap((item) => {
    const rec = item as Record<string, unknown> | null;
    return rec &&
      typeof rec.key === "string" &&
      SIGNAL_KEYS.has(rec.key) &&
      typeof rec.line === "string" &&
      rec.line.length > 0
      ? [{ key: rec.key as SmurfSignalKey, line: rec.line.slice(0, 200) }]
      : [];
  });
}

/**
 * Whether the check keeps a player out of the season's signup: findings,
 * no admin approval, and no ACTIVE signup already in. Judged at admission
 * only, like the medal (`medalRefusesSignup`): a signup already in stays,
 * and the admin signup list flags it instead (`signupFlags`).
 */
export function smurfRefusesSignup({
  signals,
  existingStatus,
  approved,
}: {
  signals: readonly SmurfSignal[];
  /** The player's signup for this season's status, or null for none. */
  existingStatus: string | null | undefined;
  /** Any admin approval of the account stands (approvedMedalMmr). */
  approved: boolean;
}): boolean {
  return signals.length > 0 && !approved && existingStatus !== REGISTRATION_STATUS.ACTIVE;
}

/**
 * Whether the check keeps a player out of the inhouse queue: findings, on a
 * player who has never finished an inhouse, with no admin approval and no
 * inhouse MMR an admin set (that admin already chose their number). A
 * player who has played is already in, and later findings never lock them
 * out.
 */
export function smurfRefusesInhouse({
  signals,
  playedInhouse,
  approved,
  adminMmr,
}: {
  signals: readonly SmurfSignal[];
  /** They have finished at least one inhouse game. */
  playedInhouse: boolean;
  approved: boolean;
  /** User.inhouseMmr as the chain reads it (adminInhouseMmr). */
  adminMmr: number | null;
}): boolean {
  return signals.length > 0 && !approved && !playedInhouse && adminMmr === null;
}

/** The signup's refusal: what the check found, and where to ask. */
export function smurfSignupRefusal(signals: readonly SmurfSignal[]): string {
  return `New signups get a smurf check, and yours needs an admin to look first: ${smurfSignalPhrase(signals)}. Ask on this page, and an admin will set the MMR you play at.`;
}

/** The inhouse join's refusal. */
export function smurfInhouseRefusal(signals: readonly SmurfSignal[]): string {
  return `New inhouse players get a smurf check, and yours needs an admin to look before your first game: ${smurfSignalPhrase(signals)}. Ask on My account, and an admin will set the MMR you play at.`;
}

/**
 * The Approve form's starting MMR for a smurf check: where their ranked
 * lobbies put them when that is known and above their medal's floor, else
 * the floor. The admin may type anything.
 */
export function smurfSuggestedMmr({
  pub,
  medalFloor,
}: {
  pub: PubStats | null | undefined;
  medalFloor: number | null;
}): number | null {
  const lobby = pub?.scout ? pubLobbyRead(pub.scout) : null;
  const fromLobby = lobby?.ranked ? lobby.mmr : null;
  if (fromLobby != null && (medalFloor == null || fromLobby > medalFloor)) {
    return fromLobby;
  }
  return medalFloor;
}
