import type { PlayoffFieldProjection } from "@/lib/playoff-field";

/** Mirror the scheduling command's eligible groups without creating fixtures. */
export function schedulableAdminTiebreakerGroups(
  tiebreakers: PlayoffFieldProjection["tiebreakers"],
) {
  if (tiebreakers.error) return [];
  return tiebreakers.groups.filter((group) =>
    group.status === "needed" &&
    (!tiebreakers.pending ||
      (group.format === "BO1_DOUBLE_ELIMINATION" && (group.stage ?? 0) > 1)),
  );
}
