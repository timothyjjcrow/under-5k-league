import { InhouseCareerCard } from "@/components/inhouse-career-card";
import { PlayerSeasons } from "@/components/player-seasons";
import { Card, CardBody, CardHeader } from "@/components/ui";
import type { Achievement } from "@/lib/achievements";
import type { ProfileSeasonRow } from "@/lib/profile-seasons";

/**
 * The profile's career band: achievements, every season they played in, and
 * the inhouse card when it isn't already leading the page.
 */
export function ProfileCareer({
  badges,
  seasonRows,
  teamLogos,
  inhouseUserId,
}: {
  badges: Achievement[];
  seasonRows: ProfileSeasonRow[];
  teamLogos: ReadonlyMap<string, string | null>;
  /** Set when the inhouse card belongs here rather than in the overview. */
  inhouseUserId: string | null;
}) {
  return (
    <section
      id="player-career"
      aria-label="Player career"
      className="scroll-mt-40 space-y-4"
    >
      {badges.length > 0 ? (
        <Card>
          <CardHeader
            title="Achievements"
            subtitle="Earned across every season's imported games"
          />
          {/* Each badge says what it is for in visible text: the
              description used to live only in a hover tooltip, which a
              phone never shows. */}
          <CardBody>
            {/* Container-sized: one column in the xl rail, two once the
                rail stacks under the main column on a tablet. */}
            <ul className="grid grid-cols-1 gap-2 @lg:grid-cols-2">
              {badges.map((b) => (
                <li
                  key={b.key}
                  className="flex min-w-0 items-start gap-2.5 rounded-lg border border-line bg-surface-2/50 px-3 py-2"
                >
                  <span aria-hidden className="text-lg leading-6">
                    {b.emoji}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      {b.label}
                      {b.count > 1 ? (
                        <span className="ml-1.5 font-mono text-xs tabular-nums text-muted">
                          ×{b.count}
                        </span>
                      ) : null}
                    </span>
                    <span className="block text-xs text-muted">{b.desc}</span>
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <PlayerSeasons rows={seasonRows} teamLogos={teamLogos} />

      {/* Inhouse career — only stream for players with a completed game
          (players with no league games get it at the top instead). */}
      {inhouseUserId ? <InhouseCareerCard userId={inhouseUserId} /> : null}
    </section>
  );
}
