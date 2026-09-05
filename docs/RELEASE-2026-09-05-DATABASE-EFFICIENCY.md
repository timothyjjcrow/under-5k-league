# Database efficiency release — 5 September 2026

The user authorized production deployment to both regional sites. This record
is separate from the application commits so deployment identifiers and live
verification can be recorded after the immutable artifacts are built.

## Scope and artifacts

This release combines each throttle attempt into one conditional SQL statement
and narrows the automation gate's marker reads. It preserves expiry boundaries,
one-winner concurrency, and failed/interrupted announcement recovery. It makes
no schema or hosting-plan change. Monthly savings remain unmeasured.

| | North America | Europe |
| --- | --- | --- |
| Canonical site | https://ggd2l.vercel.app | https://ggd2l-europe.vercel.app |
| Reviewed application SHA | `5d908c40a8f1456ef12db8d5a2151bde0e2deecc` | `b35f41e149fca90cd22fccf46e8cd9c4749f2e10` |
| Production deployment | `dpl_91p6JR9sZQSYU4JwckXSQ7oTjtyq` | `dpl_3FSAon1fp7RrALCMHopMFMgYdncm` |
| Previous deployment | `dpl_J76og69S3ksiHrvuNwUiZqSHHrPX` | `dpl_E1Kntrd1pohoc9HESqyftpoZPdV1` |
| Previous application SHA | `bb6c3efb7ff728222bc3b10c388cbfb9c11b76b2` | `becc9c4614ec1fe20a21da1511012f809d3d1406` |
| Function region | `iad1` | `fra1` |
| Full CI | [Run 33970262802](https://github.com/timothyjjcrow/under-5k-league/actions/runs/33970262802) | [Run 33973914324, attempt 2](https://github.com/timothyjjcrow/under-5k-league/actions/runs/33973914324/attempts/2) |

NA's release was cherry-picked onto its existing production revision to avoid
including unrelated Europe setup and bot changes. The two application deltas
are identical. Classification against each canonical production SHA selected
the strict lane, full PostgreSQL/mutation/browser checks, and scheduler pause;
it did not select a database migration.

## Candidate verification

Both production candidates passed the read-only production schema attestation
and build. Protected candidate probes returned 200 for liveness, readiness,
automation health, home, and schedule pages. The unauthenticated automation
endpoint returned 401; POST sync returned 405; GET sync retained its cursor,
updated, and watch contract. Titles matched the correct region. Error/fatal
runtime-log scans returned no entries at the time of verification.

Both application revisions were also exercised as previews against the
separate schema-only NA `vercel-preview` database branch. Readiness and page
checks passed; automation health correctly reported `never-run` on this empty
branch. Actual PostgreSQL concurrency and automation behavior were exercised
by the isolated full CI suites. An independent static review found no blocker.

## Production completion

The original NA and Europe exact-SHA CI runs passed all eight jobs, including
all four mutation shards, PostgreSQL integration, and Playwright. The Europe
candidate was subsequently superseded by the combined revision described below.

### North America

- Paused Worker version: `113fcb13-2e9e-4a89-9ebc-5cf77393c5ec`.
  Zero triggers verified at 14:22:22 UTC. Last observed scheduled invocation
  was 14:22:47 UTC; none arrived during the full propagation and drain window.
- After the full 15-minute bound, database observations at 14:38:43.102002 and
  14:41:40.669348 UTC were identical across more than two minutes:
  `SUCCEEDED / CRON`, null lease, zero consecutive failures; last attempt
  13:52:47.801 UTC and last success 13:52:48.930 UTC.
- Promoted the tested candidate at approximately 14:43 UTC. Canonical lookup
  confirmed the exact deployment, reviewed SHA, and `iad1` region. All eight
  live route probes passed, including correct public page titles.
- Restored active Worker version `5ec0330a-b154-4ad2-903e-1a170058dde1`;
  exactly one `* * * * *` trigger verified at 14:44:17 UTC.
- Consecutive scheduled events at 14:46:13 and 14:47:13 UTC returned outcome
  `ok` with no exceptions. The reviewed Worker awaits the endpoint and throws
  unless HTTP 200 and `{ ok: true, status: "SUCCEEDED" }` are returned.
  These can be successful quiet-window gate skips; they do not imply a new
  database maintenance attempt every minute.
- Post-resume database observation at 14:48:06.651883 UTC retained null lease,
  zero failures, and the previous successful runner state. SQL editor
  connections were left after each observation.
- A subsequent natural full maintenance run started at 14:53:13.674 UTC and
  succeeded at 14:53:14.540 UTC. The 14:54:43.273354 UTC read-only observation
  confirmed `SUCCEEDED / CRON`, null lease, and zero consecutive failures.
  No manual maintenance invocation was used.

### Europe

The original Europe candidate `dpl_DxXfSmgEqWQKEYN5jBFUXYtYvdBv`, SHA
`902041a140d04ce8079c1f154f3623dadf547e08`, passed full CI in
[run 33970263868](https://github.com/timothyjjcrow/under-5k-league/actions/runs/33970263868).
Worker version `0fedc81f-668a-4000-8f82-f26a7eaffef0` removed its trigger;
zero triggers were verified at 14:48:41 UTC. After the full propagation bound,
the 15:05:28.187769 UTC database observation showed `SUCCEEDED / CRON`, null
lease, zero failures, last attempt 14:21:47.835 and success 14:21:49.234 UTC.

The mandatory canonical-identity recheck caught a separate branding release
at `becc9c4614ec1fe20a21da1511012f809d3d1406`. The older efficiency candidate
was never promoted, preserving the new Europe logo. The remaining drain
observation was cancelled, and active Worker version
`30e3ed4a-ead0-4481-b79e-6e135c8f4091` restored exactly one trigger, verified
at 15:10:26 UTC, while the combined revision entered CI.

The restored scheduler completed consecutive successful events at 15:13:16
and 15:14:16 UTC; automation health returned 200. A read-only database
observation at 15:15:37.113552 UTC confirmed a fresh successful CRON run
(attempt 15:13:16.901, success 15:13:17.463), null lease, and zero failures.
The temporary stale automation-health response during the pause cleared after
restoration. This closed the aborted maintenance window without changing the
branding deployment.

The replacement `b35f41e149fca90cd22fccf46e8cd9c4749f2e10` is a direct child
of the current live branding commit. Its live-to-candidate binary patch is
identical to the original ten-file efficiency patch; the cherry-pick had no
conflicts. Classification again selected strict CI and scheduler pause, with
no database migration.

The combined CI's initial browser job failed one midseason reload assertion:
the player match-history section top was 79px rather than at least 80px; its
heading was partly hidden by the sticky navigation. The scroll component,
player page, and styles are unchanged from the prior green revision. All three
isolated local repeats passed at the unchanged combined SHA. It also passed in
its normal position in the full local midseason sequence; that local run was
57/58, with an unrelated options assertion racing a streaming skeleton (that
test passed in CI). Assertions were not relaxed and application code was not
modified. GitHub initially refused a job rerun while the workflow was active.
After all four mutation shards passed, one unchanged Playwright-only rerun
passed the initial, all 58 midseason, and postseason tests. All eight required
jobs are green in attempt 2; the seven successful nonbrowser jobs were retained
without rerunning. Failure and local traces are preserved outside the release
worktree.

The final maintenance window uses paused Worker version
`64ffb470-3b14-4ac0-9c1e-ebfc695aa891`, with zero triggers verified at
16:07:51 UTC. The combined production build then passed read-only attestation
of six migrations and 17 native objects at 16:08:59 UTC, completing at
16:09:39 UTC. The tested candidate is in `fra1` at the exact reviewed SHA.
All eight candidate route checks passed, including the Europe title and logo
on the home and schedule pages. The error/fatal log scan through 16:11:46 UTC
returned no entries.

The last scheduled event during propagation was 16:09:16 UTC. The full
15-minute propagation bound ended at 16:22:51 UTC. Read-only database
observations at 16:23:33.455380 and 16:26:17.154740 UTC, more than two minutes
apart, were identical: last attempt 15:13:16.901, last success 15:13:17.463,
`SUCCEEDED / CRON`, null lease, and zero consecutive failures. The SQL editor
was left after each observation. No later scheduled event arrived during the
drain, and zero triggers were reverified at 16:31:13 UTC.

The tested combined candidate was promoted at approximately 16:31 UTC.
Canonical lookup confirmed `dpl_3FSAon1fp7RrALCMHopMFMgYdncm`, the reviewed
`b35f41e149fca90cd22fccf46e8cd9c4749f2e10` SHA, and `fra1`; readiness returned
200. Active Worker version `be1e35bd-e588-4659-b4b3-e33f05329221` restored
exactly one `* * * * *` trigger, verified at 16:31:58 UTC. North America also
retained exactly one trigger.

Consecutive scheduled events at 16:34:33 and 16:35:33 UTC returned outcome
`ok` with no exceptions, proving the Worker received HTTP 200 and a successful
automation result. All eight Europe canonical route checks then passed,
including healthy automation and the Europe title and logo. North America's
eight canonical checks also passed again. An independent canonical lookup at
16:33:06 UTC confirmed both intended deployment IDs, reviewed SHAs, and regions.
Post-promotion error/fatal log scans through 16:36:19 UTC for North America and
16:36:20 UTC for Europe returned no entries.

The final read-only Europe database observation at 16:38:31.307390 UTC
confirmed a fresh natural maintenance run after promotion: attempt
16:34:34.446 UTC, success 16:34:34.883 UTC, `SUCCEEDED / CRON`, null lease,
and zero consecutive failures. No manual maintenance invocation was used.
Both regional production deployments and scheduler verification are complete.
