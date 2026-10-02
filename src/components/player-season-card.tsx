import Link from "next/link";
import { HeroIcon, RankMedal, TeamCrest } from "@/components/ui";
import { gradeTone } from "@/lib/benchmarks";
import { heroById } from "@/lib/heroes";
import { playerCardHonors, type PlayerCardFacts } from "@/lib/player-card";
import { teamTint } from "@/lib/team-tint";
import { cn } from "@/lib/utils";

const GRADE_TEXT = {
  success: "text-success",
  accent: "text-accent",
  default: "text-fg/80",
  muted: "text-muted",
} as const;

/** One figure on the card: a small label over its value. */
function CardStat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-md bg-bg/40 px-2.5 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}

/**
 * A player's season card, in their profile header: the season and how they
 * took part, their team that season (the card washed in its colour), medal,
 * MMR, grade, most-played heroes and honors. The grade and heroes cover every
 * season they played, so their labels say "Career" under a season's name.
 * Drawn only from playerCardFacts, the same facts their link picture shows
 * (OgPlayerCard).
 * `roleText` is profileCardRoleText's: the name row already badges a live
 * Captain or Standin.
 */
export function PlayerSeasonCard({
  facts,
  roleText,
  className,
}: {
  facts: PlayerCardFacts;
  roleText: string | null;
  className?: string;
}) {
  const honors = playerCardHonors(facts);
  const hasStats =
    facts.rankTier != null || facts.mmr != null || facts.grade != null;
  return (
    <div
      data-testid="player-season-card"
      className={cn(
        "relative min-w-0 overflow-hidden rounded-lg border border-line bg-surface",
        className,
      )}
    >
      {facts.team ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          {...teamTint(facts.team.id)}
        />
      ) : null}
      <div className="relative space-y-3 p-4">
        {facts.season ? (
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted [overflow-wrap:anywhere]">
              {facts.season.name}
              {roleText ? ` · ${roleText}` : null}
            </p>
            {facts.team ? (
              <Link
                href={`/teams/${facts.team.id}`}
                className="mt-1 flex min-h-11 min-w-0 items-center gap-2.5 rounded font-display text-lg font-semibold leading-tight text-fg hover:text-info"
              >
                <TeamCrest
                  name={facts.team.name}
                  seed={facts.team.id}
                  logoUrl={facts.team.logoUrl}
                  size={32}
                  imageFit="cover"
                  className="rounded-lg"
                />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {facts.team.name}
                </span>
              </Link>
            ) : null}
          </div>
        ) : null}
        {hasStats ? (
          // Auto-fit: the card shows one to three figures, and three still
          // share a row in a phone-wide card.
          <dl className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(4.5rem,100%),1fr))]">
            {facts.rankTier != null ? (
              <CardStat label="Medal">
                {/* The name under the medal, so a narrow cell never clips it. */}
                <RankMedal
                  rankTier={facts.rankTier}
                  size={32}
                  showLabel
                  className="flex-col items-start gap-1"
                />
              </CardStat>
            ) : null}
            {facts.mmr != null ? (
              <CardStat label="MMR">
                <span className="font-display text-xl font-bold leading-none tabular-nums text-fg">
                  {facts.mmr}
                </span>
              </CardStat>
            ) : null}
            {facts.grade ? (
              <CardStat label="Career grade">
                <span
                  className={cn(
                    "font-display text-xl font-bold leading-none",
                    GRADE_TEXT[gradeTone(facts.grade.overall)],
                  )}
                >
                  {facts.grade.overall}
                </span>
                {facts.grade.strength ? (
                  <span className="mt-1 block text-xs text-muted [overflow-wrap:anywhere]">
                    Strength: {facts.grade.strength}
                  </span>
                ) : null}
              </CardStat>
            ) : null}
          </dl>
        ) : null}
        {facts.heroes.length > 0 ? (
          <div>
            <p className="text-xs text-muted">Career heroes</p>
            <ul className="mt-1.5 grid grid-cols-3 gap-2">
              {facts.heroes.map((h) => {
                const hero = heroById(h.heroId);
                return (
                  <li
                    key={h.heroId}
                    className="flex min-w-0 flex-col items-center gap-1 text-center"
                  >
                    {hero ? <HeroIcon hero={hero} size={36} /> : null}
                    {/* The icon's alt text already names the hero. */}
                    <span
                      aria-hidden
                      className="max-w-full text-xs leading-tight [overflow-wrap:anywhere]"
                    >
                      {h.name}
                    </span>
                    {h.pubs ? (
                      <span className="text-xs text-muted">pubs</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        {honors.length > 0 ? (
          <p className="text-sm text-muted">{honors.join(" · ")}</p>
        ) : null}
      </div>
    </div>
  );
}
