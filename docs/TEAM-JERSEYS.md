# Team jerseys

The league sells player jerseys in two Fourthwall shops, one per group of the
US league's Season 2. Each shop holds its six teams' 30 personalized jerseys
(a player's name and position on the back).

| Group | Shop |
| --- | --- |
| A | <https://ggd2l-shop.fourthwall.com/> |
| B | <https://ggd2l-group-b-shop.fourthwall.com/> |

The addresses live in `MERCH_SHOP_URLS` (`src/lib/league-config.ts`).
`LEAGUE_CONFIG.merch.shops` is the list every Merch link on the site renders:
the header's Merch menu, the phone menu and the footer. Both leagues link the
same shops; Europe's labels say they are the US league's.

## How a team gets its jerseys

`getTeamJersey` (`src/lib/team-jerseys.ts`) links a jersey set to a team by
the team's ID, never by its name. Each set in `JERSEYS` carries the US
league's production `Team.id` it was made for (read from us.ggd2l.com/teams on
2026-11-16), so a rename by a captain or admin or a new logo never drops it.
Three teams already go by another name on the site than in their shop.

A set is the team's group and five products, position 1 first. A product's
address is `<team>-<player>-position-<n>-ggd2l-season-2-jersey` under its
shop's `/products/`; one product (First Blood, position 5) kept the address it
was created with and is written out in full. All 60 addresses answered 200 on
2026-11-16. If a product is renamed or replaced in Fourthwall, change its
address in `JERSEYS`: nothing on the site checks the shops.

A team's page (`/teams/[id]`) shows the set only while its season is the
active one, as five links and "All Group A jerseys" (`TeamJerseyLinks`);
`/teams` links each such team's card to that section.

Where the Team rows are not the production ones (fixtures, a restored copy),
the fallback is the roster: a team shows a set when at least three of its
current players are players the set was made for, ignoring case, accents and
surrounding spaces in Steam names. Three of five is a majority, so no two
teams in one season can claim the same set. If a set is ever made for a new
team, add that team's production id.

## The Season 1 preview images

The ten files in `public/merch/jerseys/` are the Season 1 front and back
mockups (800 × 800, byte-for-byte copies of Fourthwall's model-free mockups,
copied on 24 September 2026). No page shows them any more: the Season 1
products left the shop when it was restocked for Season 2, and no Season 2
mockups are in the repo.

Keep the folder. The release smoke resizes its first PNG through
`/_next/image` to prove the image optimizer works on the box
(`ops/selfhost/smoke/smoke.mjs`), and the release agent's build lists
`public/merch/jerseys` (`ops/selfhost/agent/build.mjs`).
