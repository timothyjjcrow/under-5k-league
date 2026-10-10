"use client";

import { inhouseTeamRoleNeeds } from "@/lib/inhouse";
import { DOTA_ROLES } from "@/lib/roles";
import type { LobbyTeam, Player } from "@/components/inhouse/shared";

/** A drafted side's players so far, captain first. */
export function rosterOf(team: LobbyTeam): Player[] {
  return team.captain ? [team.captain, ...team.players] : team.players;
}

/**
 * One line under a side's header: the positions nobody on it lists, or that
 * every position is covered, plus how many haven't set positions (so an
 * unknown never reads as a gap). Quiet while nobody on the side has set any.
 */
export function TeamRoleNeeds({ members }: { members: readonly Player[] }) {
  const { open, unset } = inhouseTeamRoleNeeds(members);
  const known = members.length - unset;
  if (members.length === 0 || known === 0) return null;
  const names = open.map((k) => {
    const role = DOTA_ROLES.find((r) => r.key === k);
    return role ? `${role.short} (${role.label})` : `Pos ${k}`;
  });
  return (
    <p className="border-b border-line px-4 py-2 text-xs text-muted">
      {open.length > 0 ? (
        <>
          <span className="font-medium text-accent">Needs</span>{" "}
          {names.join(", ")}
        </>
      ) : (
        <span className="text-success">Every position covered</span>
      )}
      {unset > 0
        ? ` · ${unset} ${unset === 1 ? "hasn't" : "haven't"} set positions`
        : null}
    </p>
  );
}
