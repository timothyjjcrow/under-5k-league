# GGD2L jersey production guide

Updated **24 September 2026**, after the five-team, 25-player Fourthwall rollout and the MTS/BB lower-back revisions.

This is the starting point for future jersey work. It records the method that finally worked, the approved assets to reuse, and the checks that prevent repeating the earlier design and upload problems. The product dimensions and editor behavior below were observed during this run; verify them when changing garment or supplier.

## 1. The short version

1. **Read the current brief and approved references.** Preserve the user's selected art, not an earlier approximation. For an existing team, begin with its latest approved files.
2. **Choose the real garment and inspect its print templates first.** A generated shirt photograph is an art reference, not a sewing pattern.
3. **Use ImageGen for concepts and targeted artwork/clean-background work.** Save the exact reference, prompt, and result. Keep player text and placement editable where possible.
4. **Use precise local graphics work for garment mapping and final composition.** Move and scale existing art, preserve distinctive line geometry, render lettering deterministically, and extend the background through bleed.
5. **Fit one representative jersey on Fourthwall before making the roster.** Inspect actual flat front/back and worn front/back, including shoulders, side panels, sleeves, and hem.
6. **Prepare full-size print files and personalize the approved back template.** Reuse the accepted front and sleeves. Check the longest and most unusual names first.
7. **Upload, finish the designer flow, then save the product page.** Verify the saved public product and its photo order. A local export or a designer preview is not a completed listing update.
8. **Update the manifest, deployment record, and review gallery.** Preserve original masters and record which revision is actually live.

The successful combination was **ImageGen for visual development + deterministic local editing for precision + actual Fourthwall proofs for fit**. Repeatedly regenerating the entire jersey for a small placement correction caused drift and wasted revisions.

## 2. Find the right files before editing

All paths in the tables below are relative to the repository root. `N` means the player's position, 1–5. The local review page is [player-jerseys-2026-09-23/index.html](../output/merch/player-jerseys-2026-09-23/index.html).

### Authority and precedence

| Record | What to use it for |
|---|---|
| [Deployment ledger](../output/merch/player-jerseys-2026-09-23/deployment-ledger.json) | Latest per-product revision, back asset overrides, actual proofs, and verification status. Resolve `assets` and `proofs` relative to this ledger's directory. |
| [Roster plan](../output/merch/player-jerseys-2026-09-23/roster-plan.json) | Exact existing product IDs, URLs, player aliases, positions, and roles. Recheck the roster for a new season. |
| [Master upload audit](../output/merch/player-jerseys-2026-09-23/MASTER-UPLOAD-AUDIT.json) | Approved shared front/sleeve master paths, upload copies, hashes, and dimensions. |
| [Team selection record](../output/merch/final-team-mockups-2026-09-23/TEAM-MASTERS.json) | Approved visual directions and their source folders. Its sample-player backs predate later personalizations and footer revisions. |
| Revision `manifest.json`, `QA.md`, and `storefront-verification.json` | Exact inputs/outputs, file checks, and evidence for that revision. |
| [Original catalog](../output/merch/current/catalog.json) | Historical public-product inventory and ID mapping. Despite the folder name `current`, its original print assets predate the new jersey rollout. |

**Do not choose a file merely because its name says `final`, `current`, or `300dpi`.** Some early `final` files were only the latest review candidate. Follow the ledger and the saved verification evidence.

### Approved designs and latest production backs

| Team | Accepted direction | Shared front/sleeve folder | Latest individual back folder |
|---|---|---|---|
| Bad Boys of Dota | Regal Racing Lines body; Gridline Apex large BB; Pitlane Weave small BB; Blade Stream sleeves | `output/merch/final-team-mockups-2026-09-23/bad-boys-of-dota/` | `output/merch/player-jerseys-2026-09-23/bb-gold-side-patches/` |
| My Team Sucks | Victory Weave / Triple Cut MTS | `output/merch/final-team-mockups-2026-09-23/my-team-sucks/` | `output/merch/player-jerseys-2026-09-23/mts-arrow-removal/side-marks/` |
| Bleeding Heart Dota | Fractured Standard | `output/merch/five-team-geometry-revision-2026-09-23/bleeding-heart/` | `output/merch/player-jerseys-2026-09-23/prep-mts-bleeding/bleeding-heart-dota/` |
| Sisters of the Veil | Ashen Silk; also referred to as Ash and Silk in the brief | `output/merch/five-team-geometry-revision-2026-09-23/sisters-of-the-veil/` | `output/merch/player-jerseys-2026-09-23/prep-bb-sisters-vegan/sisters-of-the-veil/posN/` |
| Vegan Squadron | Bluewater Herald | `output/merch/five-team-geometry-revision-2026-09-23/vegan-squadron/` | `output/merch/player-jerseys-2026-09-23/prep-bb-sisters-vegan/vegan-squadron/posN/` |

Final footer choices matter when making more players for an existing team:

- **MTS:** the bottom gold arrow is removed. The centered lower GGD2L and flanking bars are removed. Two plain GGD2L marks sit on the lower left/right black back panels.
- **BB:** the centered lower GGD2L and its two black bars are removed. Two black rectangular GGD2L patches with gold lettering, border, and thread texture sit on the lower left/right back panels.
- The other three teams keep their separately approved footer artwork. Do not apply BB/MTS changes to them automatically.
- The BB canonical sleeve files include the accepted **v2 angle correction**; the earlier nearly vertical sleeve bands are superseded.

For a new player, derive a clean personalization template from the **latest** team back, or explicitly apply the documented footer revision after personalization. Running an older personalization script by itself would restore an obsolete footer on BB/MTS.

## 3. Turn the brief into an approved design

### Requirements established in this project

- Professional athletic jersey appearance with an interesting main graphic.
- Full team name, a large team emblem/monogram, and a smaller abbreviated team mark presented as a patch.
- A distinct GGD2L sponsor-style logo plus the approved plain GGD2L placements, including sleeve/armband branding.
- Player name, position number, and role on the back.
- Deliberate shoulder and side artwork; sleeve decoration that works around the whole sleeve.
- Compact, centered chest wording and readable patches, with breathing room around the main art.

These are the established preferences, not a reason to override a future brief. Use the requested number of concepts; do not regenerate five alternatives when the user has already selected a design. For BB and MTS, stylized initials replaced the rejected animal/other emblem directions.

### Keep design approval separate from garment fit

Preserve the selected original concept image and record exactly which elements were chosen. A hybrid selection can combine the body, large mark, small mark, and sleeves from different options; write that down before composing it.

If extracting approved lettering or logos from a concept works cleanly, reuse those exact letterforms instead of asking ImageGen to redraw them. For MTS Victory Weave, the accepted MTS marks, title, and GGD2L sponsor were extracted and locally composited into the calibrated body. ImageGen cleaned the obsolete shield/background. See [MTS construction notes](../output/merch/final-team-mockups-2026-09-23/my-team-sucks/README.md).

For new work, retain separate background, shoulder/side art, hero emblem, mini badge, team title, sponsor, and personalization layers. The original accepted designs were flattened; recovering those layers later required clean plates and masks.

### Reusable flat-panel prompt structure

Adapt this to the selected reference and attach the actual panel/template references:

> Convert the approved design into a single flat, full-bleed [front/back/sleeve] print panel for the supplied garment template. Preserve the specified colors, distinctive stripe directions, emblem, lettering, and artwork hierarchy. Keep important content inside the actual visible garment area and continue the background into bleed. Output flat artwork, with no model, fabric folds, perspective, lighting, labels, template guides, or mockup background. Do not invent extra logos or text. [List exact elements to preserve and the one requested change.]

ImageGen improved the initial artwork transfer substantially, but it did **not** guarantee a pixel-identical reconstruction. Verify the result visually; do not call a changed stripe system an exact match.

## 4. Map artwork to the actual shirt

### Product and template used

The completed run used Fourthwall's **All-Over Print Crew Neck T-Shirt by Sublicolor**, fulfilled by Printful, with the **101** cut-and-sew templates. The downloaded [official template folder](../output/merch/official-printful-101-template/) contains front, back, left-sleeve, and right-sleeve PNG/PSD files and the guideline PDF.

| Panel | Physical upload canvas used | Final raster dimensions |
|---|---|---|
| Front | 28 × 36 inches | 8400 × 10800 px |
| Back | 28 × 36 inches | 8400 × 10800 px |
| Each sleeve | 20 × 12 inches | 6000 × 3600 px |

These dimensions describe the complete print canvas, including fabric that is cropped, sewn, folded, or wraps away from a front-facing view. They are not the dimensions of the visible chest. When changing the blank, download and recalibrate against that blank's current templates; do not reuse these values blindly.

The [geometry audit](../output/merch/five-team-geometry-revision-2026-09-23/geometry-audit.md) measured the visible front torso at approximately `u=0.133–0.866`, the front neckline bottom at `v=0.233`, and the hem at `v=0.973` for these particular 101 proofs. It used an initial identity region around `u=0.25–0.75, v=0.26–0.92`. These are empirical calibration clues, **not universal safe areas or a replacement for the template's cut lines**.

### Why the early versions looked wrong

The original generated shirt had a different silhouette and longer-looking body than the actual blank. Filling the upload rectangle with that composition made the visible artwork appear zoomed in: side art wrapped out of sight, shoulder details sat above the cut line, and chest wording spread too widely. Rebuilding the design as generic parallel stripes also lost the approved angular relationships.

### Successful correction method

1. Work in a documented native coordinate system or normalized coordinates (`u=x/width`, `v=y/height`). Keep source size and output size explicit.
2. Use neckline, shoulder seam, underarm, side seam, and hem landmarks to register the reference to the template. Check them again on the actual mockup.
3. **Move side art inward and reduce the central composition.** Shrinking only the logo will not reveal the missing side panels.
4. **Move shoulder art and chest groups down into visible fabric.** Do not only move the entire upload layer and expose unprinted bleed.
5. Preserve emblem/badge proportions with uniform scaling. Use separate background/shoulder transformations where necessary rather than stretching faces or letters.
6. Extend real background artwork through the outer sides and hem. Sample compatible texture or continue the intended stripe direction. Inspect joins; avoid transparent gaps, stretched edge smears, and mirrored lettering.
7. Render a small placement pilot, inspect it on Fourthwall, then apply the same calibrated transformation to the higher-resolution source for final export.

For a centered horizontal reduction, `u_new=(1-s)/2+s*u_old`. The successful Bleeding Heart pilot used `s=0.75`, so `u_new=0.125+0.75*u_old`, with separate vertical mappings for the shoulder and central artwork. Those values are **team-specific examples**, not universal settings. [Its notes](../output/merch/five-team-geometry-revision-2026-09-23/bleeding-heart/README.md) explain the exact transforms and limitations; [build_geometry.py](../output/merch/five-team-geometry-revision-2026-09-23/bleeding-heart/build_geometry.py) implements them.

**Apply a geometry transform once.** Give the script the untransformed same-layout source or its upscale. Feeding an already mapped panel back through the calibration shifts/scales everything twice. A square concept image and a flat portrait panel are also not interchangeable inputs.

Measure generated results instead of trusting a prompt's requested percentages: early collar/shoulder edits changed more of the shirt than intended. Uniformly shrinking a whole mockup can also create a second printed neckline and blank edges. Keep a dedicated collar region and move the art within the full-bleed panel. Automatic vector tracing was tested and rejected for this artwork because it produced serrated stripes, damaged badge contours, and halos; a low average pixel error did not mean visual fidelity. See the [vector study](../output/merch/regal-imagegen-mapping-2026-09-22/vector-fidelity-study/QUALITY-NOTES.md).

### Sleeve construction

- Treat each sleeve as one continuous wrapped fabric panel, not two copied front/back stickers.
- Place bands, weave, laurels, and cuff details across that panel so the visible halves belong to one composition.
- For patterns intended to join continuously at the underarm seam, match the left/right edge phase as well as color. Keep cuff lettering clear of the template's fold/hem region.
- Keep important logos off an untested fold/underarm join. An emblem centered on the flat sleeve can disappear when the sleeve wraps.
- Mirroring a decorative direction can help opposite-arm balance, but never mirror the readable lettering. Keep GGD2L upright on both arms.
- Do not depend on exact body-to-sleeve stripe registration. Independent bands, cuff borders, and ornaments tolerate the seam better; inspect actual joins.
- Check flat front/back **and worn views**. The first BB Blade Stream implementation looked nearly vertical on the actual shirt. The accepted correction reversed the wrap slope around the visible-half centers while preserving the cuff. See [BB sleeve v2 manifest](../output/merch/final-team-mockups-2026-09-23/bad-boys-of-dota/sleeve-v2-manifest.json) and [revision script](../output/merch/final-team-mockups-2026-09-23/bad-boys-of-dota/revise-sleeve-angle-v2.py).

## 5. Resolution and export quality

Three different claims must stay distinct:

1. **File dimensions/metadata:** the final body is 8400 × 10800 with 300-DPI metadata.
2. **Effective placement resolution:** Fourthwall reports **Good / 300 DPI** when that body file fills the 28 × 36-inch placement at the intended scale.
3. **Original detail:** much of the initial art was generated at approximately 1106 × 1422 for bodies and 1619 × 971 for sleeves. Enlargement does not recover genuinely native 300-DPI detail.

Changing DPI metadata alone did not solve the problem. The successful pipeline enlarged accepted raster art with the official local **Real-ESRGAN `realesrgan-x4plus` general model**, then performed the documented composition/geometry and final size export. New player text was rendered from font outlines directly at final resolution.

The anime upscaler pilot smoothed away too much fine texture and introduced a small edge spur. The general model preserved contours better, but also removed some very fine halftone dots. Inspect lettering, thin gold lines, texture, and possible tile seams at close range after upscaling. See the [pilot and model comparison](../output/merch/five-team-geometry-revision-2026-09-23/upscale-pilot/README.md), [batch provenance](../output/merch/five-team-geometry-revision-2026-09-23/upscaled-sources/README.md), and [tool provenance/licenses](../output/merch/.tooling/real-esrgan-macos/PROVENANCE.md).

Working settings in this run: 4× scale, tile 128, threads `1:1:1`, sequential panel processing on the local Mac. Check available tooling/platform before reusing a command. Preserve the original source; perform transformations from the intended source stage and minimize repeated resampling.

Export rules:

- Preserve lossless, opaque PNG masters at the complete panel dimensions. Do not bake template lines into the print.
- For oversized PNGs, make same-size JPEG upload copies using quality 98, `subsampling=0` (4:4:4), and `dpi=(300,300)`. Keep PNG masters.
- Use **under 50,000,000 bytes** as a conservative upload target. The observed uploader accepted some files under 50 MiB but over 50 decimal MB; do not rely on that boundary for new files.
- Decode each export and verify width, height, mode, DPI, byte size, and hash. PNG metadata commonly reads `299.9994` because of unit rounding; that is expected here.
- Short upload filenames helped the native file chooser. Some old short copies are hardlinks: **never edit them in place**, because the source inode would change too. Write a new versioned output.
- Fourthwall mockup exports are only 800 × 800 review images. Never use a downloaded mockup as a print master.

The actual print feel, color, and seam tolerances still require a physical sample if that level of assurance is needed. Screen review and a DPI label do not establish physical sample quality.

## 6. Personalize players without changing the approved design

Start with a verified roster manifest: team, exact player alias, display spelling, position, role, existing product ID, and URL. Do not infer roles from arbitrary membership order. The roles used here are 1 Carry, 2 Mid, 3 Offlane, 4 Soft Support, 5 Hard Support.

For flattened templates, the successful method was:

1. Make **one clean personalization background per team**. Remove the sample name, number, and role using a targeted ImageGen clean plate or a precise local texture repair.
2. Composite only the needed background regions into a copy of the approved master. Use broad removal cores and controlled feathering. Restore decorative rules/stars that must remain.
3. Inspect for old-letter ghosts, outlines, shadows, and rectangular texture seams. The rejected glyph-shaped repair left visible old text. Vegan needed one continuous central navy field rather than several unrelated texture boxes.
4. Render each new name, number, and role deterministically, using measured font bounds, fixed center anchors, and maximum widths. Reduce height when necessary; do not excessively squeeze long names horizontally.
5. Reuse accepted number textures inside new glyph masks and retain matching outlines where appropriate. Preserve unchanged source pixels outside the declared repair regions.
6. Make a five-player contact sheet and inspect every alias, role, and number before final export. Test long names on the actual garment.

This run used Impact for BB/BH/Sisters/Vegan and licensed Bungee for MTS. Font paths and licenses are recorded in the scripts/READMEs. Do not redistribute a system font merely because it is installed. The MTS/Sisters/Vegan typography and fitting values are examples to adapt, not automatic styles for every new team.

Exact aliases matter: `llIIIIIlllIIIIII` must retain its uppercase/lowercase pattern, `invisibilty=invincibility` retains that exact spelling and `=`, and `Bóbr Kurwa`, `CTE(Z)`, and `USDanny.ttv` retain their accents/punctuation. See the [roster audit](../output/merch/player-jerseys-2026-09-23/ROSTER-AUDIT.md).

Implementation references:

- [BB/Sisters/Vegan method](../output/merch/player-jerseys-2026-09-23/prep-bb-sisters-vegan/README.md), [accepted clean-plate script](../output/merch/player-jerseys-2026-09-23/prep-bb-sisters-vegan/prepare-clean-backs-v2.py), and [personalizer](../output/merch/player-jerseys-2026-09-23/prep-bb-sisters-vegan/personalize.py).
- [MTS/BH method](../output/merch/player-jerseys-2026-09-23/prep-mts-bleeding/README.md) and [personalizer](../output/merch/player-jerseys-2026-09-23/prep-mts-bleeding/personalize.py).
- [Saved clean-plate prompts](../output/merch/player-jerseys-2026-09-23/prep-bb-sisters-vegan/prompts.md).

Read scripts before running them. They contain roster-specific paths and can recreate **older** output states; they are reference implementations, not a universal one-command generator for future teams.

## 7. Make small revisions locally

For an approved design with one requested change, preserve the rest of the artwork. Record explicit edit rectangles/masks, use nearby compatible texture for removal, and compare the result with the source at full size. Verify PNG pixels outside those regions are unchanged and original hashes remain intact. JPEG compression can affect pixels throughout the image; use PNGs for exact preservation comparisons.

Examples from the final revisions:

- [MTS side-mark revision](../output/merch/player-jerseys-2026-09-23/mts-arrow-removal/side-marks/README.md): remove the arrow and centered footer; reuse the original GGD2L silhouette at two safe lower-side positions. The accepted marks are centered near `(240,1330)` and `(866,1330)` on a 1106 × 1422 reference panel.
- [BB gold patch revision](../output/merch/player-jerseys-2026-09-23/bb-gold-side-patches/README.md) and [script](../output/merch/player-jerseys-2026-09-23/bb-gold-side-patches/relocate_gold_patches.py): repair the cream center, extract the existing wordmark silhouette, recolor it gold, and compose a black woven-looking rectangle with a double gold border and fine stitch lines. Accepted patch size is 110 × 52 at centers `(231,1310)` and `(875,1310)` on the same reference size.

These coordinates passed the actual existing blank's flat/worn previews. Recalibrate for a different blank or side-panel shape. The patches are **printed embroidery effects**, not physical sewn patches. Keep the product description accurate; actual embroidery would require a compatible product/production method.

## 8. Upload and verify on Fourthwall

Use the current supported browser/connector tools and follow their documentation. The previous run used Chrome browser controls, with native macOS file selection when the browser file-chooser interface timed out. Tool names, AX indices, tab IDs, and sessions are transient; do not copy old runtime identifiers into a new chat.

### One pilot first, then the roster

1. Open the correct product by its verified ID, then **Edit product design**. Confirm player identity and panel before editing.
2. For an existing-team revision, replace only the changed back panel. For a new team, validate all four panels on the representative jersey.
3. Delete the old placement layer and add the replacement file. Confirm the **exact uploaded filename**, dimensions/placement scale, and **Good / 300 DPI** after processing completes. An import-start message is not proof of upload success.
4. Review actual flat front/back and worn views. Check shoulder caps, neckline, title width, logo spacing, side-art visibility, sleeve direction, cuff lettering, and the lower hem. Scroll if the preview is taller than the viewport; do not approve unseen lower art.
5. Download actual front/back proofs and associate them with that exact product and revision. Verify the files show the correct player before updating records.
6. Finish **Publish now** or the appropriate saved review flow, according to the user's authorized listing visibility. Wait for photo generation to return to the product page.
7. Click the outer product-page **Save**. This is a separate step. Wait for completion; a success toast is useful, but a missing toast needs a fresh persisted-product check rather than assuming failure or success.
8. Reload a separate product/admin view and inspect the public listing when public publication is authorized. Verify the new back, player details, visibility, price, URL, and photo order.
9. Inspect the actual gallery count. Some edits appended old/new images; later revisions already had exactly four correct views. Retain only the intended current product photos, with front cover first and back second. Do not blindly delete four images based on an earlier run.

The 25-player rollout explicitly replaced existing public listings. That authorization should not be generalized into publishing every new concept. Follow the current brief, and preserve existing authorization rather than asking for it again. Where a new decision is necessary, prepare the reviewable result before requesting that decision.

### Reliability lessons

- Native Chrome's **Back** button and the designer's **Back panel** button share a label. Scope the action to the design iframe; accidentally navigating back can lose work.
- Re-read UI state after actions and verify the active product URL before native file-picker interactions. User focus can change.
- File chooser selection can leave the dialog open or leave a blank back. Verify the completed layer and DPI; never publish a blank placement.
- Photo generation can sit at 95% for several minutes. Work on another independent product while it finishes. Avoid reloading an unpublished edit. For a genuinely stalled published draft, inspect its persisted state and exact files before attempting recovery; do not repeatedly publish blindly.
- Keep one owner for native uploads/downloads. Parallel artwork preparation and independent QA help; simultaneous file-picker control or unsynchronized proof downloads cause mistakes.
- The old capture helpers select the last two `Downloads/mockup*.png` files. This only works when front/back downloads are serialized and immediately checked. For future automation, record explicit download paths instead of assuming global download order.
- Actual public-image inspection was useful when the storefront carousel reset after resizing. Use only image URLs observed in that product's UI, and verify they are its current gallery images.

## 9. Save enough evidence for the next chat

For each new revision, retain:

- Selected reference(s), the brief/approval choices, and exact ImageGen prompts.
- Original immutable sources; editable layers or clean background templates where available.
- Reproducible composition/geometry/personalization scripts and font/license references.
- A manifest with exact names, roles, product IDs/URLs, source/output hashes, dimensions, DPI, file sizes, and coordinate/edit-region definitions.
- Lossless masters, upload copies, local previews, and actual Fourthwall front/back proofs. Retain flat front, flat back, worn front, and worn back for representative design approval; those views establish sleeve direction and side visibility.
- Local QA and a separate live verification record with timestamps.
- Updated per-product ledger paths/status and a refreshed review gallery.

The current [gallery builder](../output/merch/player-jerseys-2026-09-23/build_review.py) honors `deployment-ledger.json` asset overrides. Current BB/MTS revision helpers show how the ledger is updated: [BB helper](../output/merch/player-jerseys-2026-09-23/bb-gold-side-patches/update_revision.py), [MTS helper](../output/merch/player-jerseys-2026-09-23/mts-arrow-removal/update_revision.py). Read/adapt them for a new revision rather than replaying old verification. Historical evidence must not mark a new revision verified.

The existing roster/gallery scripts assume this five-team, 25-player run. Adding teams requires extending their manifests and count/identity checks; do not run the old fixed-roster workflow unchanged for a larger league.

The gallery is a static HTML file and can open locally. If its localhost link is unavailable, the file still exists. An optional preview server from the repository root is:

```sh
python3 -m http.server 8766 --bind 127.0.0.1 --directory output/merch
```

Then open `http://127.0.0.1:8766/player-jerseys-2026-09-23/index.html`. Do not start a second server if that port is already serving the review.

Keep the artwork folders with this guide when moving workspaces or machines. The Markdown guide alone cannot reconstruct the exact approved ImageGen output, and local `output/` artifacts may not be carried by Git. Fourthwall has its own uploaded copies; changing local files alone never updates the store.

### Suggested starting instruction for a future chat

> Read `docs/JERSEY-PRODUCTION-GUIDE.md` and the latest jersey deployment ledger before starting. Use the approved team masters and preserve existing design decisions. For new teams, develop the requested concepts, map one representative jersey to the actual Fourthwall template, verify its flat and worn views, then personalize the roster with deterministic text. Use full-size 300-DPI exports, verify the actual saved listings, and update the manifests and review gallery. Reuse the established workflow instead of repeating the earlier mapping experiments.
