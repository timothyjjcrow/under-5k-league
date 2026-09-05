# Homepage layout release — 5 September 2026

Status: both regional production deployments are complete and verified.

The homepage sidebar now matches the weekly results card's desktop height.
Upcoming matches and recent results scroll inside their cards, with fixed
headers and schedule links. Mobile lists have bounded heights and keyboard
access. The fix changes only `src/app/page.tsx` and
`src/components/league-results-map.tsx`.

## Release candidates

| Site | Commit | Deployment | Region |
| --- | --- | --- | --- |
| NA | `4783c4d4b73a2b7486f8006646c0807f23236cf4` | `dpl_4QUaHK3ELRrUJuiotYbCMxdv2rwv` | `iad1` |
| EU | `420c96e36f72ef9a2211942f956bdd2c6f2be1ae` | `dpl_HMCXoqKXmWUW5EsWfX5gU83q4aJ6` | `fra1` |

The two release patches are byte-identical and were cherry-picked directly
onto each provider-verified production revision. Trusted classifiers from
those production commits select the app lane, with PostgreSQL, mutation and
browser CI required, and no database release or scheduler pause.

## Verification before promotion

Both immutable revisions passed isolated Preview health and route checks
against the existing empty preview database. Its automation probe correctly
returns 503 before its first maintenance run. The two production candidates
passed production-environment validation and read-only attestation of all six
migrations and 17 native database objects.

Each candidate passed eight route checks: liveness, readiness, automation
health, home, schedule, unauthenticated automation rejection, POST sync
rejection and the GET sync contract. Error-level runtime scans returned zero
entries. Both candidates retain their expected regional titles and function
regions.

The North America candidate was visually checked with actual production data:
five teams, all five recent results accessible, a zero-pixel difference between
the table and sidebar bottoms at 1440px, and no page overflow at 390px. Europe's
current signup homepage renders correctly at desktop and mobile sizes. The
regular-season layout was also checked locally under the Europe configuration.
Browser error lists were empty. Production-candidate browser access used
Vercel's authenticated bypass cookie; deployment protection was retained.

CI: [North America](https://github.com/timothyjjcrow/under-5k-league/actions/runs/33978825400),
[Europe](https://github.com/timothyjjcrow/under-5k-league/actions/runs/33978827470).

## Production verification

North America passed all eight CI jobs and was promoted to
`dpl_4QUaHK3ELRrUJuiotYbCMxdv2rwv`. The canonical homepage has zero-pixel
misalignment between the weekly card and sidebar. All eight canonical route
checks passed, the error-level log scan was empty, and three consecutive
post-promotion scheduler events returned `ok` with no exceptions.

Europe attempt 1 passed seven jobs. Mutation shard 3 reported a surviving
`inhouse-service.ts::finish::OR+status#1` mutation. The affected service, test
file and mutation harness are byte-identical between the successful North
America revision and Europe. A focused probe at the unchanged Europe revision
on an isolated local PostgreSQL 18 database reported the claim `PROTECTED`;
the baseline was not changed, and the test worktree was restored cleanly.
The local test database and server were shut down afterward.

The remaining initial Europe shard continued to produce successful claim
checks and eventually passed. Only the failed mutation shard was then rerun;
the seven successful jobs are retained. All eight jobs passed in
[attempt 2](https://github.com/timothyjjcrow/under-5k-league/actions/runs/33978827470/attempts/2).


Europe was then promoted to `dpl_HMCXoqKXmWUW5EsWfX5gU83q4aJ6` without
rebuilding. The immediate canonical-identity recheck matched its reviewed
previous deployment. All eight canonical route checks passed, both desktop
and mobile homepages rendered with Europe branding and no horizontal overflow,
and the error-level runtime scan returned no entries.

Both canonical URLs were verified as READY on their intended candidate IDs.
North America's canonical mobile page also retained the 320px results-list
limit with no page overflow. The sole scheduler for each region remained
active throughout; no database migration, backup refresh or scheduler pause
was required or performed.

Previous known-good deployments: North America
`dpl_91p6JR9sZQSYU4JwckXSQ7oTjtyq` at
`5d908c40a8f1456ef12db8d5a2151bde0e2deecc`; Europe
`dpl_3FSAon1fp7RrALCMHopMFMgYdncm` at
`b35f41e149fca90cd22fccf46e8cd9c4749f2e10`.

Post-promotion successful scheduler observations:
- NA: 2026-09-05T17:14:13.286000+00:00, 2026-09-05T17:15:13.285000+00:00, both `ok` with zero exceptions.
- EU: 2026-09-05T18:00:33.109000+00:00, 2026-09-05T18:01:33.112000+00:00, both `ok` with zero exceptions.
