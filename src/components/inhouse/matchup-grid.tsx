"use client";

import { Avatar, Badge, PlayerLink, RankBadge } from "@/components/ui";
import { cn } from "@/lib/utils";
import { avgKnownMmr } from "@/lib/inhouse";
import { sideMeta, type RoomLobby } from "@/components/inhouse/shared";

/** Both sides' rosters, shared by the Set up and Play screens. */
export function MatchupGrid({ lobby }: { lobby: RoomLobby }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {lobby.teams.map((t) => {
        const meta = sideMeta(t.isRadiant);
        const roster = t.captain ? [t.captain, ...t.players] : t.players;
        // Shared with the drafting columns and the balance banner — this grid
        // used to average the unknowns in as zeroes and disagree with both.
        const avgMmr = avgKnownMmr(roster.map((p) => p.mmr));
        return (
          <div
            key={t.team}
            className={cn(
              "rounded-[var(--radius)] border bg-surface/80",
              meta.ring,
            )}
          >
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div className="flex items-center gap-2 font-semibold">
                <span className={cn("h-2.5 w-2.5 rounded-full", meta.dot)} />
                {meta.name}
              </div>
              {avgMmr > 0 ? (
                <span className="text-xs text-muted">avg {avgMmr} MMR</span>
              ) : null}
            </div>
            <div className="space-y-1.5 p-3">
              {roster.map((p, i) => (
                <div key={p.userId} className="flex items-center gap-2 text-sm">
                  <Avatar name={p.name} src={p.avatar} size={24} />
                  <PlayerLink
                    userId={p.userId}
                    className="min-w-6 flex-1 truncate"
                  >
                    {p.name}
                  </PlayerLink>
                  {i === 0 ? <Badge tone={meta.badge}>C</Badge> : null}
                  <RankBadge rankTier={p.rankTier} />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
