# GGD2L Europe branding

The Europe deployment uses `public/brand/ggd2l-europe-logo.png`, a 1254 × 1254 PNG. CSS lightening blends its midnight background into the site's dark surfaces. The existing US assets are preserved.

`LEAGUE_CONFIG.branding` selects the regional logo for the header, footer, sign-in and error pages, app icons, social previews, and Discord queue-board author icon. The former Next.js metadata image files live in `public/` at their original URLs so file-convention metadata cannot override the regional selection.

The same Europe image is used for the Discord server icon, bot avatar, and announcement/queue/alert webhook avatars.

The September 5 branding release is on `codex/europe-logo-release` at `becc9c4`, based on the previously live Europe commit `7bed06e`. It includes the logo and background blending, without the separately prepared database efficiency changes. The development branch also contains both branding commits. Validation: TypeScript, scoped ESLint, 69 existing configuration/metadata/queue-board tests, production build, readiness check, live website logo and metadata inspection, and Discord icon/avatar verification.

## Image generation provenance

Tool mode: built-in `image_gen.imagegen`, reference-image edit.

Reference: `public/brand/ggd2l-logo.png`.

Initial prompt:

> Use case: text-localization / logo-brand. Edit the supplied existing GGD2L badge into the official GGD2L Europe logo. Preserve its recognizable sculpted dark bronze/wood medieval Dota esports shield, red Dota symbol at top, dimensional warm copper highlights and existing strong GGD2L lettering. Add the exact uppercase word "EUROPE" prominently below "GGD2L", beautifully integrated into the lower band of the badge in matching embossed metallic lettering, crisp high contrast and wide enough to read in a small Discord icon. Exact text: first line "GGD2L" (G G D 2 L), second line "EUROPE". Make the lower badge area accommodate EUROPE naturally, balanced elegant typography and fine craftsmanship, not pasted-on text. No additional slogans, words, flags, stars, maps or decoration. Straight-on, centered, clean studio rendering, one finished logo, no mockup or collage. Square 1024x1024 image with a genuinely transparent background, no fake checkerboard. Badge occupies approximately 88% of square, all important lettering inside a circle-safe central area, clean alpha edges. Website and Discord production asset. Keep the red symbol and bronze identity faithful to reference. Polished, legible, premium.

The initial output had a baked checkerboard, so the final edit used this prompt:

> Precise background edit of the provided finished logo. Preserve exactly the beautiful GGD2L EUROPE bronze badge, lettering, red symbol, shape, proportions and every interior detail. Remove the entire gray-and-white checkerboard background and replace it with a perfectly solid uniform deep midnight charcoal background RGB(11,15,23), hex #0b0f17, matching the website. Opaque background; no transparency and no checkerboard, texture, glow, gradient or shadow outside the badge. Single square final production image. Keep all badge/text fully inside the frame, centered with a modest safe border. Text must remain exactly GGD2L on top and EUROPE below. Do not change or redesign the badge.

Final generated source: `exec-60cac830-94a4-41bb-8eca-11de9c133f85.png`. Copied unmodified to the public asset above.
