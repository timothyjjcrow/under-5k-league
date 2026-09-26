/** Who an imported account belongs to. Lineup-derived position and rating
 * snapshots are optional: result imports resolve players from the roster and
 * standin cover, and older stored games may still carry the extra fields. */
export type ImportIdentity = {
  userId: string; name: string; teamId: string | null;
  plannedPosition?: number; positionSource?: string;
  ratingSnapshot?: number; ratingSource?: string; ratingAt?: string;
};
