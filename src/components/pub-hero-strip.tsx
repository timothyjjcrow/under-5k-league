import { HeroIcon } from "@/components/ui";
import { heroById } from "@/lib/heroes";
import type { PubHero } from "@/lib/pub-stats";

/**
 * What they ACTUALLY play: a few pub heroes as small icons, never merged with
 * the self-picked favorite heroes, which have their own strip. The visible
 * label is what tells the two apart on a phone, where both sit in one row;
 * it is aria-hidden because the strip's own spoken label already says it.
 * role="img" + a spoken label per the decorative-indicator convention; each
 * icon's title names the hero and its record. Shared by the /players
 * scouting card and the draft room's (draft-player-card.tsx).
 */
export function PubHeroStrip({
  label,
  heroes,
  titleOf,
}: {
  label: string;
  heroes: PubHero[];
  titleOf: (h: PubHero) => string;
}) {
  return (
    <span className="flex items-center gap-1">
      <span aria-hidden>{label}</span>
      <span
        role="img"
        aria-label={`${label}: ${heroes
          .map((h) => heroById(h.heroId)?.name ?? `Hero #${h.heroId}`)
          .join(", ")}`}
        className="flex items-center gap-1"
      >
        {heroes.map((h) => {
          const hero = heroById(h.heroId);
          // title on the ICON, not a wrapper — the browser shows the innermost
          // title, and the img fills any span around it.
          return hero ? (
            <span key={h.heroId} aria-hidden>
              <HeroIcon hero={hero} size={18} title={titleOf(h)} />
            </span>
          ) : null;
        })}
      </span>
    </span>
  );
}
