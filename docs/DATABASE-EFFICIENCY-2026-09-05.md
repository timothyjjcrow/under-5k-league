# Database efficiency review — 5 September 2026

Both leagues run the same application against separate Neon databases. The
console was inspected read-only at 10:08 UTC. No database schema, production
configuration, scheduler interval, or hosting plan was changed. Application
changes in this review require deployment to each site before affecting usage.

## Observed usage

| | North America | Europe |
| --- | --- | --- |
| Neon project | `under 5k league` | `ggd2l-europe-db` |
| Plan | Launch | Free |
| Production compute | Autoscaling 0.25–8 CU | Fixed 0.25 CU |
| Suspend after inactivity | 5 minutes, enabled | 5 minutes |
| State during inspection | Suspended | Idle |
| Production usage since September 1 | 8.46 CU-hours | 0.11 of 100 CU-hours |
| All project branches | 9.01 CU-hours | 0.11 CU-hours |
| Production storage | 35.3 MB | 33.69 MB |

Sources: [NA branch usage](https://console.neon.tech/app/projects/crimson-heart-25180140/branches),
[NA compute settings](https://console.neon.tech/app/projects/crimson-heart-25180140/branches/br-purple-hat-atfhgnu9/computes),
[Europe branch usage](https://console.neon.tech/app/projects/jolly-flower-08491639/branches),
[Europe compute and metrics](https://console.neon.tech/app/projects/jolly-flower-08491639/branches/br-late-fog-b1ap78ik/monitoring/metrics).
These pages require the owner's Neon access. Console metrics may lag an hour;
Europe had existed for only about an hour and cannot support a monthly forecast.

At Launch's published $0.106/CU-hour, NA's observed 9.01 CU-hours is about
**$0.96 in compute so far this month**, excluding storage and other invoice
items. Europe currently uses its free allowance. Compute billing depends on
allocated compute size multiplied by active time. Lower query CPU does not
guarantee a smaller bill if the database remains awake at the same minimum
size. [Neon pricing](https://neon.com/pricing)

NA's recent graph showed repeated inactive windows, active allocation around
0.25 CU, and low CPU use. The 8-CU maximum is a permitted peak, not a continuous
allocation. Both databases already use scale-to-zero successfully. No live
top-query timings were available: the query-performance view did not finish
loading while the endpoint was idle.

## Application improvements

- **One SQL statement per throttle attempt.** Room maintenance, provider
  cooldowns, and announcement throttles previously used two statements when a
  claim was fresh or absent. The conditional insert/update now handles these
  cases in one statement. An indexed fresh-claim check avoids locking the row
  on ordinary losing requests; the conflict predicate still elects one winner
  under concurrent requests. A successful stale claim already cost one
  statement. Expiry boundaries and cooldown durations stay the same.
- **Read only relevant automation markers.** The scheduler gate selects the
  exact reminder, completed-match announcement, and honors keys used by its
  deadline calculation instead of retrieving all historical keys under those
  season prefixes. Global failed or interrupted announcements remain eligible
  for recovery, including orphaned markers.

These reduce repeated database work in both deployments. The percentage saved
on a particular query path is not a percentage reduction in the monthly bill.
Live polling intervals, deadline recovery, cache freshness, and competitive
state transitions retain their existing contracts.

## Validation

- Full unit suite: 2,288 passed.
- Full SQLite integration suite: 1,248 passed, 39 skipped (including
  PostgreSQL-only cases).
- TypeScript, ESLint, and whitespace/diff checks passed.
- The exact throttle SQL passed 36 checks on an isolated local PostgreSQL
  database, including 12 simultaneous contenders for missing and stale claims.
  A fresh request returned while a competing transaction held the row lock.
- The existing protected mutation-test claim ID and baseline are retained.
  Removing the SQL guards caused the expected behavioral failure on PostgreSQL.
  The full PostgreSQL integration/mutation suites were not run locally; the new
  Prisma test for a contender blocked behind a winning transaction is included
  for that CI suite.
- Scheduler tests compare the full resulting snapshot against the previous
  broader marker reads and verify current reminders and orphaned retries.

## Remaining cost levers

1. **Keep monitoring compatible with sleep.** `/api/health/ready` deliberately
   executes `SELECT 1` on every request. Probing it at or below the five-minute
   idle timeout can prevent suspension. `/api/health/live` does no database
   work; `/api/health/automation` uses the existing cached gate during sleep.
   Keep real readiness checks for outage detection and deployments, choosing
   their frequency with the detection-delay tradeoff in mind. The observed
   sleep windows do not show an always-on monitoring problem today.
   [Neon scale-to-zero](https://neon.com/docs/introduction/scale-to-zero)
2. **Preserve the existing idle automation gate.** The authoritative scheduler
   still checks once per minute, but its cached decision avoids unnecessary
   database access until work is due, with a one-hour hard recheck. Slowing the
   scheduler itself would affect live deadlines and retries.
3. **Avoid speculative downsizing or indexes.** NA's low observed load does not
   justify restricting its peak capacity without match-night measurements.
   A lower maximum does not save money while allocation is already 0.25 CU.
   Potential future indexes are `Bid(draftId, userId, createdAt)` for the live
   bid trail and `Match(seasonId, scheduledAt)` for import windows. Confirm
   their benefit with representative PostgreSQL plans before accepting extra
   write/storage overhead and a migration.
4. **Keep temporary branches expiring.** NA's five non-production branches
   used approximately 0.55 CU-hours in total this period and were all idle.
   They are a small housekeeping opportunity, not the main compute cost.
   Preserve rollback/release branches until their retention purpose expires.

After deploying, compare each project's CU-hours, active-time gaps, allocated
CU, and query timings over comparable traffic and match-night periods. Verify
that both endpoints still suspend when idle and that automation remains
healthy. Current evidence supports incremental savings, not a large recurring
cost reduction or a plan change.
