import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { SEASON_STATUS } from "./constants";
import {
  CAPTAIN_LOGO_HOST_ERROR,
  isCaptainLogoHost,
  normalizeTeamLogoUrl,
} from "./team-logo";
import {
  normalizeTeamName,
  teamNameKey,
  type TeamIdentityChange,
} from "./team-identity";
import { stampResultChange } from "./settings";
import { raceHook } from "./race-hook";
import { isSerializationConflict } from "./prisma-errors";

/**
 * A team's public identity — its name and logo — edited by its captain from the
 * team page, or by an admin from the team page or /admin. One implementation so
 * the two doors can never check different things. The actions own the activity
 * log and the Discord announcement, so a webhook failure never touches the
 * write.
 */

export type TeamIdentityEditor = { userId: string; isAdmin: boolean };

export type SavedTeamIdentity = TeamIdentityChange & {
  ok: true;
  teamId: string;
  seasonId: string;
};

export type TeamIdentityResult = SavedTeamIdentity | { ok: false; error: string };

const NOT_ALLOWED =
  "Only this team's captain or an admin can edit it. If the captaincy just changed, reload the page.";

const STALE_FORM =
  "This team's name or logo changed since you opened this form. Reload to see the current one, then save again.";

/** An expected refusal; its message is shown to the editor as-is. */
class TeamIdentityRefused extends Error {}

export async function saveTeamIdentity(input: {
  editor: TeamIdentityEditor;
  teamId: string;
  /** The season the form was rendered for; any other season reads as unknown. */
  expectedSeasonId?: string;
  name: string;
  /** The raw logo field. Undefined leaves the logo as it is. */
  logoUrl?: string;
  /**
   * The name and logo ("" for none) the form was showing. When given, a save
   * from a form opened before someone else's edit is refused instead of
   * silently reverting that edit. Undefined skips the check (a form rendered
   * before this field existed).
   */
  expected?: { name: string; logoUrl: string };
}): Promise<TeamIdentityResult> {
  const name = normalizeTeamName(input.name);
  if (!name) return { ok: false, error: "Enter a team name" };
  const logo =
    input.logoUrl === undefined ? undefined : normalizeTeamLogoUrl(input.logoUrl);
  if (logo && "error" in logo) return { ok: false, error: logo.error };

  await raceHook("teamIdentity.save.beforeTx");
  try {
    return await prisma.$transaction(
      async (tx): Promise<SavedTeamIdentity> => {
        const team = await tx.team.findUnique({
          where: { id: input.teamId },
          select: {
            name: true,
            logoUrl: true,
            seasonId: true,
            season: { select: { isActive: true, status: true } },
          },
        });
        if (
          !team ||
          (input.expectedSeasonId && team.seasonId !== input.expectedSeasonId)
        ) {
          throw new TeamIdentityRefused("Unknown team");
        }
        if (!team.season.isActive) {
          throw new TeamIdentityRefused(
            "That season is archived, so its teams can't be edited.",
          );
        }
        if (team.season.status === SEASON_STATUS.COMPLETE) {
          throw new TeamIdentityRefused(
            "The season is complete — team details are historical and read-only.",
          );
        }
        // The form posts the whole identity, so a tab opened before another
        // edit would write the old name or logo back over it. This reads the
        // same row the transaction then writes: a rival committing in between
        // makes the Serializable save fail (the "just changed" refusal).
        if (
          input.expected &&
          (input.expected.name !== team.name ||
            input.expected.logoUrl !== (team.logoUrl ?? ""))
        ) {
          throw new TeamIdentityRefused(STALE_FORM);
        }
        // Standings, fixtures and Discord lines tell teams apart by name, and a
        // captain must not be able to pass their team off as another one.
        const others = await tx.team.findMany({
          where: { seasonId: team.seasonId, id: { not: input.teamId } },
          select: { name: true },
        });
        if (others.some((other) => teamNameKey(other.name) === teamNameKey(name))) {
          throw new TeamIdentityRefused(
            `Another team is already called ${name}. Pick a different name.`,
          );
        }
        // Authorization lives in this WHERE and nowhere else: the captaincy
        // can move (transferCaptaincy) between the page render and this write,
        // and the outgoing captain must not rename a team that is no longer
        // theirs. Admins edit any team in the season. The two writes are
        // spelled out (not one WHERE with a conditional spread) so the
        // mutation guard can see and gate the captain's claim.
        const data = { name, ...(logo ? { logoUrl: logo.logoUrl } : {}) };
        const changed = input.editor.isAdmin
          ? await tx.team.updateMany({
              where: { id: input.teamId, seasonId: team.seasonId },
              data,
            })
          : await tx.team.updateMany({
              where: {
                id: input.teamId,
                seasonId: team.seasonId,
                captainId: input.editor.userId,
              },
              data,
            });
        // The first write, so nothing is committed yet: refusing is safe.
        if (changed.count === 0) throw new TeamIdentityRefused(NOT_ALLOWED);
        // A captain's NEW logo must be on a host they don't control. Checked
        // once the claim has shown this is the team's captain, and thrown,
        // so the write above rolls back. Only a change is checked: the form
        // re-posts the current logo, which may be one an admin set on another
        // host, and a rename must still save.
        if (
          !input.editor.isAdmin &&
          logo?.logoUrl &&
          logo.logoUrl !== team.logoUrl &&
          !isCaptainLogoHost(logo.logoUrl)
        ) {
          throw new TeamIdentityRefused(CAPTAIN_LOGO_HOST_ERROR);
        }
        const nameChanged = name !== team.name;
        const logoChanged = logo !== undefined && logo.logoUrl !== team.logoUrl;
        // Record snapshots embed team names; fence older in-flight refreshes.
        if (nameChanged || logoChanged) await stampResultChange(tx);
        return {
          ok: true,
          teamId: input.teamId,
          seasonId: team.seasonId,
          previousName: team.name,
          name,
          nameChanged,
          logoChanged,
          logoUrl: logo ? logo.logoUrl : team.logoUrl,
          byCaptain: !input.editor.isAdmin,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof TeamIdentityRefused) {
      return { ok: false, error: error.message };
    }
    if (isSerializationConflict(error)) {
      return {
        ok: false,
        error: "The season or team just changed — reload and try again.",
      };
    }
    throw error;
  }
}
