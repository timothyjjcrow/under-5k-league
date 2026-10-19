# Releasing GGD2L

The US and Europe sites run the same commit from `main` on one self-hosted
box, and every release ships that commit to both through
`npm run release:both` (`scripts/release-box.mjs`). This first section is the
whole routine release: plan, check the change, then build, check and promote
both leagues on the box. The appendices cover database and scheduler changes,
incidents and the reference material, and link to the guarded procedures that
govern them.

> **Status: live.** Both leagues moved from Vercel and Neon to the box on
> 2026-10-17 ([DECISIONS](DECISIONS.md#hosting)), and every release since then
> follows this page. The one-time cutover had its own runbook, kept outside
> the repository; `ops/selfhost/README.md` (Cutover helpers) covers the kit's
> parts of it. The Vercel-era procedure this page replaced is at
> `git show 33a1f348:docs/RELEASING.md` and no longer applies: never "Instant
> Rollback" a GGD2L Vercel project.

## How the box serves a league

- **Slots.** Each league has two slots, `a` and `b` (US on 127.0.0.1:3001 and
  3002, Europe on 3011 and 3012), each a `next start` process run by
  `ggd2l-us@.service` or `ggd2l-eu@.service`. Caddy sends the league's traffic
  to one of them, the live slot; only the live slot is enabled, so the 09:00
  UTC reboot brings back exactly it.
- **Releases** are built on the box from a clean clone at the exact commit,
  one directory per release, and a slot points at one of them. A release takes
  about 1.2 GB; the box keeps the live one, the previous one and the newest.
- **The agent** (`/usr/local/sbin/ggd2l-agent`) does every box operation:
  build, start, check, promote, rollback and the rest. It runs as root through
  `sudo`, validates its arguments, never takes a secret in argv and prints one
  JSON object. `release:both` calls it over SSH; you can too, with this helper
  (the alias defaults to `ggd2l-1`; set `GGD2L_BOX_SSH` for another):

  ```sh
  box_agent() { ssh -o BatchMode=yes "${GGD2L_BOX_SSH:-ggd2l-1}" sudo -n /usr/local/sbin/ggd2l-agent "$@"; }
  box_agent status
  box_agent live us
  ```

## Routine release

### Before you start

- The commit is on `main` and its CI run passed. The release finds that exact
  run and checks the jobs your change needs, including both browser suites
  and the step that boots the built site the way the box runs it.
- You have a checkout of that commit with no uncommitted changes to tracked
  files.
- You are signed in to the GitHub CLI (`gh`); the release only reads.
- `ssh ggd2l-1 true` works without a prompt: the alias in `~/.ssh/config`
  pins the box's host key and logs in as `ggd2l` with your key. The release
  holds no other credential.
- It is between **07:00 and 19:00 UTC**, and no match night, inhouse night or
  draft is on. The release refuses outside those hours unless you pass
  `--outside-window`, which is for a reviewed emergency only.
- Nobody else is releasing: check for another release session first.

### 1. Plan

```sh
npm run release:both -- --check
```

This reads the commit each league runs from the agent (`live`) and checks it
against the public `https://us.ggd2l.com/api/health/release` and
`https://eu.ggd2l.com/api/health/release`, which must report that commit, the
league's own `site` and `deployEnv: "production"`. It classifies the change
for each league with the classifier from that league's live commit and finds
the passing CI run. It changes nothing on the box. The plan is saved in the
release's evidence folder, `backups/release-<date>/` (gitignored).

Look at the classifications for both leagues:

- `needs_db_release` and `needs_scheduler_pause` both `false`: this is a
  routine release. Carry on.
- Either one `true` for either league: stop. This is a maintenance release;
  follow [Appendix B](#appendix-b-database-and-scheduler-changes) first.
  Each classification's `reasons` names the files behind it. A file the live
  classifier does not know reads `unknown path` and sets both flags even when
  nothing touches the database or scheduler; the README's
  [classifier notes](../README.md#hosting-and-release-setup) say how a path
  becomes known.

### 2. Check the change yourself

The release checks health and that pages load, not what they look like or
whether a flow still works. That part is yours, before you release: the
focused checks in [Every release](PRODUCTION-OPERATIONS.md#every-release)
step 3. There are no Previews. See a UI change on a fixture server
(`npm run fixture:signups`, `fixture:regular`, `fixture:playoffs`,
`fixture:complete`) on desktop and mobile, and exercise the affected API,
sign-in and player, captain or admin flows there. For a change a fixture
can't show, use the on-demand staging slot
([DECISIONS](DECISIONS.md#hosting)): the production build against a scrubbed
copy of the database, reached only through `ssh -L`. It is designed, not
built: no unit or agent verb runs it yet, so build it before the first change
that needs it.

### 3. Release

```sh
npm run release:both -- --apply
```

In order, this:

1. **Builds both leagues** on the box, the US then Europe, before starting
   either candidate, so at most three Next processes ever run. Each build runs
   `scripts/vercel-build.mjs` with the league's production environment, so it
   validates the environment and attests the real database's migrations,
   schema and native objects read-only before compiling. A build takes a few
   minutes on the one vCPU.
2. **Starts and checks each candidate** in the league's idle slot: it must be
   live within 90 s, then pass the shared smoke
   (`ops/selfhost/smoke/smoke.mjs`) against 127.0.0.1 with
   `--expect production`: the health and release probes, the home and
   schedule pages and their pictures, the same-origin guard, the sign-in
   redirects, image resizing and the overlay. Nothing calls `/api/sync` or
   `/api/health/automation` on a candidate.
3. **Promotes** the US, then Europe. Promote restarts the candidate clean,
   waits for it to be live and ready, swaps the league's Caddy mode file to
   point at it and reloads Caddy. After each, the release reads
   `/api/health/release` through Cloudflare until three answers in a row show
   the new commit, and `/api/health/automation` must be healthy unless the
   scheduler is paused.
4. **Watches** the Caddy log through the agent for two scheduled
   `/api/cron/automation` passes answered 200, 30 to 90 seconds apart, and no
   5xx. At least 90 seconds after each promote it retires the old slot (stopped
   and disabled, its release kept for rollback) and prunes old releases.

The evidence folder then holds the plan, the report (the previous and new
release of each league, the classifications, the CI run and every promotion),
a record and a box manifest (release ids, the Node version, the build logs'
SHA-256 and the Caddy config's). It holds ids, commits and outcomes, never
credentials. Attach it to the private
[release evidence record](PRODUCTION-OPERATIONS.md#release-evidence-record)
that every release fills in.

### 4. Check the live sites

On `https://us.ggd2l.com` and `https://eu.ggd2l.com`, look at the pages you
changed, and scan the error rows since the release:
`box_agent logs us <epoch ms>` (a 5xx row reads `level: "error"`; a Next
error in the journal reads `warn`). [Every release](PRODUCTION-OPERATIONS.md#every-release)
step 6 lists what to check.

### If it fails

Any failure prints one line saying what failed and exits with an error. The
report's `status` says `failed` and its `error` repeats the reason. Agent
errors carry only a fixed `code`, never a command's output.

- **Before promotion** (plan, CI, a build, a candidate that won't start, the
  smoke): neither live site has changed. The build log is
  `/var/log/ggd2l/builds/<id>.log` on the box, with every environment value
  redacted. Fix the cause and run the release again.
- **During or after promotion** (a canonical read that won't show the new
  commit, a 5xx, two scheduled passes not seen): the release promotes every
  league it promoted back to that league's previous release, both leagues
  together, and says what it did. If it says a league needs operator review,
  see [Appendix C](#appendix-c-incidents-and-manual-recovery).
- **Cleanup left to finish by hand** (an old slot not retired, or a prune
  that failed, after a verified release): the release itself succeeded.
  Finish with `box_agent retire <lg> <id>` (it refuses the live release and
  anything within 90 s of a promote) and `box_agent prune <lg>`.

### Rolling back a release that finished

Roll back by slot. The agent keeps the previous release on disk and promotes
it again, restarting it clean:

```sh
box_agent rollback us
box_agent rollback eu
```

Roll back both leagues: one commit serves both. Never undo a migration: the
database stays as it is and the older build keeps working with it.

Each rollback runs once. It restarts a slot and waits for it, up to about two
silent minutes; if the answer is lost or reports a failure, read
`box_agent live <lg>` first: the switch may have happened. A second
`rollback` while live came from one refuses with `rolled_back`, because the
release it left has become the previous one and a bare retry would put it
back. Its answer names `live` and `rolledBackFrom`; to return to that release
on purpose, `box_agent promote <lg> <rolledBackFrom>`. Any promote, a release
included, makes `rollback` available again.

- A schema-neutral rollback between releases with the same authenticated
  automation contract needs no backup or scheduler pause: roll back, check
  the probes and one database-backed page, and watch the next two scheduled
  passes (`box_agent logs`).
- A rollback that crosses a schema or scheduler boundary, predates the
  authenticated cron route, or has uncertain compatibility uses the strict
  sequence in [Code/config rollback](PRODUCTION-OPERATIONS.md#codeconfig-rollback),
  which pauses the scheduler first.

## Appendix A: One application, two leagues

US and Europe use the same `main` branch, application components, rules,
standings engine, database schema and migrations. Do not keep regional feature
branches or cherry-pick routine changes between leagues. Make the change once.

`src/lib/league-config.ts` owns public regional configuration. Each league
keeps its own database (`ggd2l_us` and `ggd2l_eu` on the box's Postgres, each
with its own owner and app roles), environment file (`/etc/ggd2l/us.env`,
`/etc/ggd2l/eu.env`), Discord credentials and guild, authentication secret,
server-action key, origin, timezone, match schedule and game-server region.
The one lobby bot serves both through the shared regional protocol. Never copy
player data, fixture results, runtime settings or secrets between leagues. An
administrator editing a season edits only that league's data.

### How the paired release works

CI runs the complete browser suites for both `us` and `eu`, including signup,
regular season, playoffs and BO1/BO3 tiebreakers, and boots the built site
the way the box runs it. The release verifies exact-commit CI and each
league's live identity, classifies each delta with that league's trusted live
classifier, then builds both candidates on the box from the same commit, each
with its own league's environment. Both builds must pass their read-only
migration, schema and native-object attestation, and both candidates the
shared smoke, before either league's traffic moves.

Promotion uses the tested candidates without rebuilding. Each site must
report the reviewed commit, its own region and its own origin at
`/api/health/release`. There is no atomic promotion across the two leagues,
so they move one after the other. If either promotion or verification fails,
the release puts every league it promoted back on its previous release.

For routine releases the release also watches the Caddy log for errors and
waits for two consecutive scheduled automation passes on each league. A
failure there triggers the same paired recovery. A release that paused a
scheduler ends waiting for the operator to resume and verify each paused
scheduler under the operations procedure.

Evidence holds release ids, commits and outcomes, never credentials. Observe
the scheduler and log gates in
[Production operations](PRODUCTION-OPERATIONS.md) before closing a release.

### Retired with the move

- **Previews** and the **Prepare both leagues** workflow
  (`.github/workflows/release.yml`, deleted): the box has no Previews. Its
  staging is the on-demand slot ([DECISIONS](DECISIONS.md#hosting)), designed
  but not yet built.
- **The hosted migration job** (`scripts/hosted-migration-release.mjs`):
  migrations run on the box through the agent (Appendix B).
- **Staging a Vercel candidate and promoting it** (`--stage-only`,
  `--promote-from`): the box builds and promotes in one run.
- After the cutover the Vercel projects serve only redirects to the new
  origins. **Never "Instant Rollback" a GGD2L Vercel project**: it would put
  the old app back on the old origin, serving a frozen copy of the league.

The Vercel-only scripts stay until a cleanup PR deletes them
([deferred](DECISIONS.md#deferred-on-purpose)); `release:both` no longer runs
them.

## Appendix B: Database and scheduler changes

One committed Prisma schema and migration history applies to both
databases. The release attests both against that same history; drift in
either blocks the paired promotion. Builds never run migrations.

A change classified as affecting the database or scheduler stops the release
before any build. Complete this procedure for every affected league, record
evidence for each, and never mark a failed league complete. Then release with
`--maintenance-file <private-json>`. A change that needs a database release
always needs the scheduler pause as well.

### The order, for each affected league

The linked sections are authoritative; follow each one exactly. Each league's
scheduler is its own: US `npm run scheduler:pause` and
`npm run scheduler:deploy`, Europe `npm run scheduler:europe:pause` and
`npm run scheduler:europe:deploy`.

1. **Pause the scheduler** when `needs_scheduler_pause` is set, then complete
   the checks in [Pause and resume](PRODUCTION-OPERATIONS.md#pause-and-resume).
   Wait the full 18.5 minutes (the 15-minute propagation bound, two further
   minute slots and the 90-second lease drain). Then
   `box_agent cron-requests <lg> <epoch ms>` must count 0 across two minute
   slots, and `box_agent lease <lg>` must report both fields `null`. Keep it
   paused until the release is promoted.
2. **Back up** when `needs_db_release` is set: `box_agent backup <lg>` makes
   a fresh dump, verifies it and copies it offsite. Record its SHA-256 and R2
   object key from the answer.
3. **Rehearse:** `box_agent prepare <sha>` installs the tools at the reviewed
   commit, then `box_agent drill <lg> <sha>` restores the newest dump into the
   scratch database `ld2l_restore_test` and migrates it with that commit's
   migrations, through `scripts/rehearse-backup-restore.mjs`.
4. **Migrate:** `box_agent migrate <lg> <sha>` runs the guarded migration
   release (`scripts/release-migrations.mjs --apply <sha>`, the script behind
   `npm run db:migrate:release`) from that tools clone as the league's owner
   role, with `VERCEL_ENV=production` set only in that process, then checks
   the app role's grants (`grants-check`, which must report no problems). If
   it fails, stop and follow
   [Fully rolled-back failed migration](PRODUCTION-OPERATIONS.md#fully-rolled-back-failed-migration).
5. **Record the evidence** in a private file outside the repository (shape
   below), then release with it:
   `npm run release:both -- --apply --maintenance-file <private-json>`. The
   build attests the **new** schema.
6. **Resume the scheduler.** Deploy each paused scheduler and complete the
   two-pass gate in
   [Controlled promotion](PRODUCTION-OPERATIONS.md#controlled-promotion)
   step 5.

The Preview migration step this procedure used to start with is retired: the
box has no Previews.

### Maintenance evidence

The evidence shape is `headSha` and `regions.us`/`regions.eu`. Each affected
region records `baseSha`, `reviewedBy`, and `observedAt` (within six hours).
Database impact requires `backupVerified`, `restoreRehearsed`, and
`migrationReleasePassed`. Scheduler impact requires `zeroTriggers`,
`zeroTriggersAt`, `quietSlotsVerified`, and `noActiveLease`, with the full
propagation and drain interval elapsed. These are attestations to actual
evidence the operations runbook requires, not permission to skip its steps:
for the backup that evidence is the pre-release dump's SHA-256 and its R2
object key, and for the quiet window the agent's `cron-requests` and `lease`
answers. Keep schedulers paused until their reviewed release is promoted;
then resume and observe two successful scheduled runs.

`headSha` is the commit you are releasing and each `baseSha` is that league's
live commit from the `--check` plan. The release refuses the file until 18.5
minutes have passed since `zeroTriggersAt`. For one affected league the file
looks like this, with every value a real, reviewed observation:

```json
{
  "headSha": "<the commit you are releasing>",
  "regions": {
    "us": {
      "baseSha": "<that league's live commit>",
      "reviewedBy": "<reviewer>",
      "observedAt": "<ISO 8601 time>",
      "backupVerified": true,
      "restoreRehearsed": true,
      "migrationReleasePassed": true,
      "zeroTriggers": true,
      "zeroTriggersAt": "<ISO 8601 time>",
      "quietSlotsVerified": true,
      "noActiveLease": true
    }
  }
}
```

Each paused Worker also sets `AUTOMATION_PAUSED=true`, so late Cloudflare ticks
cannot dispatch application requests. Verify the deployed flag, active version,
empty trigger list, and actual absence of automation requests in the Caddy log
under the operations runbook. The guard does not replace the full propagation,
quiet window, or lease-drain checks. Resume both with the flag set to `false`.

## Appendix C: Incidents and manual recovery

These procedures live in [Production operations](PRODUCTION-OPERATIONS.md) and
the README. Their scheduler commands are the US ones; for Europe use
`npm run scheduler:europe:pause` and `npm run scheduler:europe:deploy`.

- **The release's own recovery asked for operator review:** compare each
  league's live release (`box_agent live <lg>`) with the report's previous and
  new releases and decide what that league should run. To put a league back,
  use [Code/config rollback](PRODUCTION-OPERATIONS.md#codeconfig-rollback).
- **Suspected data-integrity problem:** stop new writes first with
  [Traffic freeze and incident triage](PRODUCTION-OPERATIONS.md#traffic-freeze-and-incident-triage).
- **Code or configuration fault, data trustworthy:**
  [Code/config rollback](PRODUCTION-OPERATIONS.md#codeconfig-rollback) and the
  README's [Application rollback order](../README.md#application-rollback-order).
- **Corrupt or missing data:**
  [Data recovery](PRODUCTION-OPERATIONS.md#data-recovery).
- **A leaked secret:**
  [Secret compromise](PRODUCTION-OPERATIONS.md#secret-compromise).
- **Scheduler Worker fault or a `CRON_SECRET` rotation:**
  [Rotate or roll back](PRODUCTION-OPERATIONS.md#rotate-or-roll-back).
- **A failed migration release:**
  [Fully rolled-back failed migration](PRODUCTION-OPERATIONS.md#fully-rolled-back-failed-migration).
- **The box is down or unreachable:**
  [Box operations](PRODUCTION-OPERATIONS.md#box-operations), including the
  rebuild from zero.

## Appendix D: Reference

- [Release evidence record](PRODUCTION-OPERATIONS.md#release-evidence-record)
  — the private record to fill in for a release.
- [Every release](PRODUCTION-OPERATIONS.md#every-release) — the full
  pre-promotion procedure. `npm run release:both` runs its classification, CI
  check, builds, candidate smoke, promotion and two-pass check; the focused
  checks and error-log scans in steps 3 and 6 are yours.
- [Box operations](PRODUCTION-OPERATIONS.md#box-operations) — the box itself:
  units, alerts, backups, drills, the monthly hour and a rebuild from zero.
- `ops/selfhost/README.md` — the kit's condensed runbook: layout, daily
  operations, backups, restore, a rebuild from zero (the install), the Origin
  CA fallback and the cutover helpers.
- [Hosting and release setup](../README.md#hosting-and-release-setup) —
  environment variables, the release classifier, the migration commands,
  legacy baseline adoption and the scheduler.
- [Backups](../README.md#backups) and
  [Health monitoring and scheduler](../README.md#health-monitoring-and-scheduler-required)
  in the README.
- [EUROPE-SETUP.md](EUROPE-SETUP.md) — Europe's origin, scheduler commands and
  recovery configuration.
- [PRODUCTION-READINESS-2026-08.md](PRODUCTION-READINESS-2026-08.md) — the
  August 2026 launch-readiness audit, kept as history. It is not a runbook.
