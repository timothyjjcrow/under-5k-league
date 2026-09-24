# Team jersey preview assets

The ten files in `public/merch/jerseys/` are byte-for-byte copies of the
model-free front and back mockups downloaded from Fourthwall for each team's
position-1 player jersey. Each is an 800 × 800 RGBA image; none was rendered,
retouched, or recomposed locally. All source and destination SHA-256 hashes
matched when copied on 24 September 2026.

Resolve the source proof paths below relative to
`output/merch/player-jerseys-2026-09-23/`. The current source of truth for
revisions and verification is that folder's `deployment-ledger.json`, while
`roster-plan.json` records the product IDs and storefront URLs.

| Team | Representative product | Current Fourthwall proof folder | Public preview files |
| --- | --- | --- | --- |
| Bad Boys of Dota | [Borpo (1)](https://ggd2l-shop.fourthwall.com/products/bad-boys-of-dota-jersey-borpo-1) | `bb-gold-side-patches/proofs/pos1/` | `bad-boys-of-dota-{front,back}.png` |
| Bleeding Heart Dota | [Power (1)](https://ggd2l-shop.fourthwall.com/products/bleeding-heart-dota-jersey-power-1) | `proofs/bleeding-heart-dota/pos1/` | `bleeding-heart-dota-{front,back}.png` |
| My Team Sucks | [Big Dawg SaMy (1)](https://ggd2l-shop.fourthwall.com/products/my-team-sucks-jersey-big-dawg-samy-1) | `mts-arrow-removal/side-marks/proofs/pos1/` | `my-team-sucks-{front,back}.png` |
| Sisters of the Veil | [saukko (1)](https://ggd2l-shop.fourthwall.com/products/sisters-of-the-veil-jersey-saukko-1) | `proofs/sisters-of-the-veil/pos1/` | `sisters-of-the-veil-{front,back}.png` |
| Vegan Squadron | [llIIIIIlllIIIIII (1)](https://ggd2l-shop.fourthwall.com/products/vegan-squadron-jersey-lliiiiillliiiiii-1) | `proofs/vegan-squadron/pos1/` | `vegan-squadron-{front,back}.png` |

Each proof folder contains `front-fourthwall.png` and `back-fourthwall.png`.
The back is personalized for the named player. If Fourthwall product artwork is
revised, recopy the corresponding verified proofs selected by the deployment
ledger and check the live product before presenting them as current.

The live league database currently names My Team Sucks `w4tkins's Team`.
The roster plan records that league-name alias, and all five current players
match the merchandise roster. The preview mapping accepts both team names and
keeps `My Team Sucks` as the jersey label.
