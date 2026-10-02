// A team's colour on its own surfaces, so teams feel like teams: a faint wash
// behind the team page's header, behind each side of a match's scoreboard and
// across a player's season card, and a stripe down the edge of each side's
// box in the match page's cards. Pure and tested (team-tint.test.ts proves the
// wash keeps text readable on every hue; team-crest.test.ts that every
// element painted with a team's hue names its team).
//
// The colour is the team's crest hue (teamHueVar), published by the root
// layout's stylesheet on elements that carry `data-team-hue`. CSS custom
// properties only reach an element through that attribute or inheritance, so
// each helper returns the attribute WITH the style: spread both onto the one
// element that paints.

import type { CSSProperties } from "react";
import { teamHueVar } from "./team-hues";

/**
 * How strong the wash is (the alpha over the host's background).
 * team-tint.test.ts checks, for every hue, that body, muted and link text and
 * every Badge tone keep 4.5:1 on it over the page background, a card surface
 * and the hero banners' lightest corner. A lighter host (surface-2 and up)
 * leaves the Badges no room at all, so a wash never sits on one: the same test
 * reads each wash's host from the source.
 */
export const TEAM_TINT_ALPHA = 0.07;

/** The wash's colour: the middle of the team's crest gradient. */
function washColour(teamId: string, alpha: number): string {
  return `hsl(${teamHueVar(teamId)} 62% 37% / ${alpha})`;
}

/** Props for an element painted in a team's colour. */
export type TeamHueProps = {
  "data-team-hue": string;
  style: CSSProperties;
};

/**
 * A wash layer: spread onto an EMPTY `pointer-events-none absolute` element
 * inside a `relative overflow-hidden` host, before the content. A layer of its
 * own rather than the host's background, so the host keeps its gradient (an
 * inline `background` would wipe it), and empty so its hue can't reach a
 * nested crest of another team. `fade` lets the wash die away towards one
 * side: each half of the scoreboard clears before the score in the middle.
 */
export function teamTint(
  teamId: string,
  fade?: "to right" | "to left",
): TeamHueProps {
  const colour = washColour(teamId, TEAM_TINT_ALPHA);
  return {
    "data-team-hue": teamId,
    style: fade
      ? {
          backgroundImage: `linear-gradient(${fade}, ${colour} 40%, ${washColour(teamId, 0)})`,
        }
      : { backgroundColor: colour },
  };
}

/**
 * A stripe down the left edge of a box that belongs to one team. Decorative:
 * the team's name in the box says whose it is. An inset shadow draws inside
 * the border and follows the rounded corners without moving the content.
 */
export function teamStripe(teamId: string): TeamHueProps {
  return {
    "data-team-hue": teamId,
    style: { boxShadow: `inset 3px 0 0 hsl(${teamHueVar(teamId)} 62% 46%)` },
  };
}
