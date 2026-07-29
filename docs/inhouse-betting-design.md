# Inhouse betting — recommendation and implementation plan

## The recommendation (what a player experiences)

The last pick lands, teams lock, and the READY screen gets a clock for the first time: **45 seconds, bets open.** Above the lobby name and password sits a two-bar panel — your side's pool and theirs — with one-tap chips (10 / 25 / 50 / MAX 100) and a **COVER** button that stakes exactly the amount needed to match the gap. You can only ever bet on your own team, once, and you cannot take it back. Everyone's stake is public the instant it lands, so the panel is a live argument: "they're 160 ahead — somebody take it." **Only matched Cred is live** — if your side over-stakes, the excess is simply never in play and comes straight back, and the panel says so on the button before you tap ("100 staked · 40 covered · 60 comes home"). Matched Cred pays even money. Forty-five seconds later it locks, they go play, and when OpenDota reports the game the room's existing post-game banner gains one line beside the Elo delta: `+43 Cred · 43 of your 100 was covered`. The Discord result post gains a slips block naming who was in for what. `/inhouse` gains a second ladder — **net Cred**, not balance — where the fourteenth-best player in the league can be first.

---

## Why this and not the others

**The Cover wins on the one property that cannot be retrofitted: it is zero-sum.** In Back Yourself and The Ante the payout comes from a house with no capital and no exposure limit, so a throw conspiracy mints currency with no counterparty to notice, and a model-arbitrage edge (a smurf, a friend back from a break) bleeds a phantom for a year before the calibration monitor can say anything. Critique 1 is right that a matched pool caps a conspiracy's take at exactly what honest players on the throwing side chose to risk, and that if a losing side knows it's losing it stakes zero, so **the value of perfect information is zero rather than "the opponents' ante."** Everything else follows from that.

I then killed the parts of The Cover the critics broke:

- **From The Ante: the board ranks net betting profit, not balance.** This is the single best line in any of the three documents. It makes the bankruptcy floor harmless (critique 1's designated-donor money printer dies outright), makes attendance unrankable, and centres the scoreboard at zero forever.
- **From The Ante: void a bet whose frozen team no longer matches the post-`teamFixes` roster.** The Cover's "the bet follows the player" rule is a live two-man arbitrage — swap slots in the hand-hosted Dota lobby and your 100 rides the strong side while your friend's 10 rides the weak one, with `classifyGame`'s majority vote classifying it cleanly. Voiding makes a slot swap EV-zero in *both* directions, so nobody arranges one.
- **From The Ante: 45 seconds, matched to `ACCEPT_SECONDS`.** 120s is a real toll charged on the phase where ten people are trying to leave the browser. Critique 2 is right that this is 75 seconds × 3 games a night of standing around.
- **From The Ante: a per-lobby settlement state column with its own claim, plus a lazy resolver.**
- **From Back Yourself: the slips block in the Discord result post** (the best conversion surface any of the three produced) and **the late-bet void keyed on the played match's own `start_time`** — Valve's clock is the one timestamp ten interested parties cannot forge.
- **From Back Yourself: one refund rule, not four.** `resolveUnsettledBets` covers cancel / ready-check failure / abandon / void uniformly instead of bolting refund legs inside four already-hardened claims.
- **From critique 3, the best structural catch in the set: any check performed post-claim must be computable from COLUMNS**, because the request that computed the inputs is allowed to die. So `matchStartTime` is persisted into `applyResult`'s *existing* claim data, and the lineup check compares two persisted columns. The crash-recovery path is then byte-identical to the fast path.

And I **deleted The Cover's auto-ante entirely.** Critique 3 is right: eleven writes in a resolver chain that every anonymous page view on the site executes, making a money write a precondition for a lobby advancing, is the worst idea in any of the three designs. Its stated jobs — liveness and capping the value of perfect information — are better served by *not having it*: with no ante, perfect information is worth zero, and a faked pot on the pinned board is worse than an honest empty one.

**Rejected outright and permanently:** any odds model, any rake, any house, any MMR or Elo input to the price, any spectator bet, any transfer, and any Elo consequence for bet size.

---

## The mechanic

**Currency: Cred.** Integers only. No transfers, no gifting, no purchases, no cash-out.

| Constant | Value | Reason |
|---|---|---|
| `START_BALANCE` | 500 | Five max bets. Column default, so `db push` funds every existing account. |
| `MIN_STAKE` / `STEP` | 10 | One-tap chips, never a text input. |
| `MAX_STAKE` | **100, flat, forever** | Never a fraction of balance. A newcomer and the ladder leader max out at the same number on night one, and a conspiracy's per-game take is bounded at 500. |
| `WINDOW_SECONDS` | 45 | Same rhythm as the ready check. |
| `FLOOR` | 100 | Bankruptcy net. |
| `REAL_GAME_SECONDS` | 600 | The floor only pays on a game that looks like a game. |

**Faucets — the complete list.** (1) `START_BALANCE` 500, once per account, ledgered `GRANT`. (2) `FLOOR`: at settlement of a COMPLETED lobby with `durationSecs >= 600`, a participant below 100 is topped up to 100 — **at most once per UTC day per player**, enforced by the ledger's `@@unique([reason, refId])` with `refId = "<userId>:<yyyy-mm-dd>"`. No stipend, no per-game drip, no login bonus.

**Sinks.** None, and none is needed: **betting is exactly zero-sum.** Matched Cred moves between the ten; it is never created or destroyed. That is what makes a big balance mean "I took it off someone."

**Window.** Opens on the DRAFTING→READY transition (`betsCloseAt = now + 45s`, stamped in the same `data` block as `status: READY`). Closes on `betsCloseAt` alone — **pressing Start does not close it**, so nobody is ever the person who "closed the ante," and Start stays instant. Eligibility: you are one of the ten, you bet on `me.myTeam`, once, immutably.

**Payout formula.**

```
Discard voided bets first (VOID_LINEUP, VOID_LATE) — they are refunded in full
and never enter the pools.

P1 = Σ team-1 stakes      P2 = Σ team-2 stakes      M = min(P1, P2)

Short side  (pool == M):  matched_i = stake_i                      (ratio 1.0)
Long side   (pool == L):  matched_i = floor(stake_i × M / L),
                          then the shortfall M − Σ matched_i is handed out
                          one Cred at a time by LARGEST FRACTIONAL REMAINDER,
                          ties broken by userId ascending.

net delta_i = (stake_i − matched_i)   [unmatched, always returned]
            + matched_i               if your side won
            − matched_i               if your side lost
```

Largest-remainder (Hamilton) allocation conserves exactly: `Σ winners' matched == Σ losers' matched == M`, to the Cred, with no float drift. The `userId` tiebreak is the repo's total-order convention (`hall-of-fame.ts:43`, `pickem.ts:65-70`).

### Worked example 1 — balanced pool, the favoured side wins

```
Team 1 (favoured)   Kessler 100 · Roo 50 · Vex 40 · Bo 10 · Ash —    P1 = 200
Team 2              Dooley  100 · Mig 60 · Nine 40 · Pia — · Q —     P2 = 200
M = 200 · both sides matched at ratio 1.0 · pot 400 → HIGH STAKES

Team 1 wins:  Kessler +100  Roo +50  Vex +40  Bo +10   = +200
Team 2:       Dooley −100   Mig −60  Nine −40          = −200      ✓ conserved
```

### Worked example 2 — the underdog side out-stakes the favourite, and wins

```
Team 1 (favoured)   Ash 100 · Bo 20 · three abstain                  P1 = 120
Team 2 (underdog)   Dooley 100 · Mig 100 · Nine 60 · Pia 20          P2 = 280
M = min(120, 280) = 120.  Short side is TEAM 1 → matched 1.0.
Long side ratio = 120/280 = 0.428571:
   Dooley 100 → 42.857 → 42 (.857)     Mig  100 → 42.857 → 42 (.857)
   Nine    60 → 25.714 → 25 (.714)     Pia   20 →  8.571 →  8 (.571)
   Σ = 117, shortfall 3 → largest remainders: Dooley, Mig, Nine +1 each
   Final: Dooley 43 · Mig 43 · Nine 26 · Pia 8 = 120 ✓

Team 2 wins:  Dooley +43 (57 comes home) · Mig +43 · Nine +26 · Pia +8 = +120
Team 1:       Ash −100 · Bo −20                                       = −120  ✓
```

The underdog side's extra 160 was never live and returns untouched. **Betting into a vacuum is free bravado — and the panel says so before you tap.**

### Worked example 3 — lopsided pool

```
Team 1   all five at MAX 100                                         P1 = 500
Team 2   Q 20, four abstain                                          P2 =  20
M = 20 · long-side ratio 20/500 = 0.04 → each T1 player matched for 4.

Team 1 wins:  five × +4 = +20 (and 96 each comes home).  Q −20.
```

Staking 500 against 20 wins 20. And Team 2's read of that same screen is *"they are offering 480 Cred of free action."* One Team 2 player tapping **COVER 100** takes P2 to 120 and M to 120 — and *he* is matched at ratio 1.0 against a side that is already all-in. **The short side always gets the best utilisation**, which is the built-in magnet back toward balance and the entire reason the COVER button exists.

### The Elo answer, plainly

**Bet size touches the Elo ladder in no way whatsoever.** `summarizeInhouse` keeps its exact signature, `INHOUSE_ELO.K` stays 32, `FinishedLobby` gains no stake field, and no Elo or MMR value is an input to any payout. Three reasons, in order of how much they matter:

1. **The expectation is the two sides' AVERAGE rating** (`inhouse-stats.ts:96-102`). A stake-scaled K means one player's wallet moves the yardstick the other nine are rated against, without their consent — precisely the "someone else's money decides my outcome" class the own-team rule exists to eliminate.
2. **It destroys reproducibility, which is what makes `voidLastResult` safe.** The code says so at `inhouse-service.ts:1493-1497`: flipping a lobby to CANCELLED works *because* nothing was stored and every rating recomputes on the next read. Feed stakes into the fold and voiding a lobby or refunding one bet retroactively re-rates every game after it.
3. **Blast radius is four independent full-history scans plus a captain-selection method** (`inhouse/page.tsx:349`, `inhouse-service.ts:1199`, `inhouse-board-service.ts:275`, `players/[id]/page.tsx:906`, and RECORD ordering via `loadRecords`). All four would have to start loading bet rows on paths the code deliberately keeps free of history scans.

What the user actually wants — *big bets should mean something visible* — is delivered by a **second ladder**: net Cred profit, rendered as a column beside Elo on the existing ladder card. Two numbers, two stories: Elo is skill, Cred is nerve. #8 in Elo and #1 in Cred is a genuinely interesting person to be, and it is a scoreboard available to someone who is not the best Dota player in the Discord — which is the point of a league called *Learn Dota 2*. One free bonus falls out with no code: because matched pools are even money, a lopsided lobby produces a small pot (the weak side declines) and an even lobby a big one, so **the pot size is a live read on how close the ten think the game is.**

---

## Anti-abuse

| Exploit | The rule that kills it |
|---|---|
| **House-banked throwing** — bet max on yourself, a friend on the other side abstains and feeds; the payout is minted from nothing. (Fatal for the two rejected designs.) | **Matched pools.** A payout must be funded by an opposing stake. A conspiracy's take is capped by what honest players on the *throwing* side voluntarily risked. |
| **Perfect information** — play the game, learn the result, then bet. | With no ante, the losing side stakes 0, so `M = 0` and the winners collect nothing. **Worth exactly zero, as a property of the mechanism, not a check.** |
| **…and the check anyway: the late bet.** `startGame` has no time gate and `constants.ts:275-285` explicitly blesses a late Start. | `matchStartTime` is persisted into `applyResult`'s **existing** claim `data`. Any bet with `placedAt > matchStartTime` → `VOID_LATE`, full refund, excluded from the pools. Because it is a column, the crash-recovery resolver enforces it identically to the fast path. |
| **Slot-swap arbitrage** — A (weak side, 100 staked) and Z (strong side, 10 staked) swap slots in the hand-hosted Dota lobby; `teamFixes` moves A's stake onto the strong side. | `bet.team ≠` the player's post-`teamFixes` `InhouseLobbyPlayer.team` → **`VOID_LINEUP`**, full refund, removed from the pools before they are computed. A swap is EV-zero in both directions, so nobody arranges one. The other eight bets settle normally — one person's cold feet never destroys nine people's action. |
| **Admin cancels a losing game mid-`IN_PROGRESS`** to unwind bets. `cancelLobby`'s claim covers `IN_PROGRESS` today. | `cancelLobby` gains a relation filter on the `IN_PROGRESS` branch (`bets: { none: { confirmedAt: { not: null } } }`), the `reopenMatch` pattern. Cancelling a live game with confirmed bets requires an explicit `force`, which goes through `DangerSubmit`, writes an `AdminAction`, and posts a Discord alert naming the admin and the pot. Admins are **not** locked out — an unkillable lobby holds the single active slot for six hours, a strictly worse failure. |
| **`voidLastResult` used as a betting undo.** | Same treatment: the reversal is keyed to the lobby the void's claim actually won, an `AdminAction` is written, and the Discord alert names the pot. |
| **The designated-donor floor mint** — a player parks at exactly the floor, max-bets every game, loses, is restored, and whoever covered him keeps freshly minted currency forever. | Three cuts. (a) **The board ranks net betting profit, not balance** — the mint is liquidity, never score. (b) Floor top-up at most **once per UTC day per player**, enforced by `@@unique([reason, refId])`. (c) Only on a game with `durationSecs >= 600`, which also kills 4-minute-feed-fest faucet farming. |
| **Model / MMR arbitrage** — sandbag a self-reported queue MMR to move a payout multiplier (`joinQueue` trusts a free-typed number for unregistered, unlinked accounts). | **There is no price.** Even money, no odds model, no MMR input, no Elo input. Queue MMR keeps driving captain ordering and the balance meter, where it is cosmetic. |
| **Spectators, alts, proxies.** | The write's WHERE carries `lobby: { players: { some: { userId, team } } }` — eligibility is derived from `InhouseLobbyPlayer`, never from having a session. `/api/inhouse` answers `state` *before* the 401 gate, so "is signed in" would be no gate at all. |
| **Double-click / two tabs / two devices.** | `@@unique([lobbyId, userId])` (bets are single-shot and immutable) plus `balance: { gte: stake }` in the WHERE of the debit. |
| **Betting after an admin cancel lands mid-request.** | The window claim's relation filter (`lobby: { status: { in: [READY, IN_PROGRESS] }, betsCloseAt: { gt: now } }`) — the `acceptMatch` pattern. `count === 0` throws, the debit rolls back, the player is charged nothing. |
| **Stranded settlement** — the request that won the COMPLETED claim dies before the payout, and nothing re-triggers (every result path requires `IN_PROGRESS`). | `resolveUnsettledBets()` in **both** resolver chains, and in `syncInhouse` **above** the `!active && queued === 0` early return — which is exactly the state (game over, everyone left) where the sweeper is needed and the current chain does not run. |
| **A bet bug 500s the room.** The resolver chains have no try/catch and `/api/sync` runs them on every page view of the entire site. | The bet resolver — and only it — is wrapped in try/catch that logs and continues. It must never stop ten people from playing Dota. |

**Left open, stated honestly:**

- **Two friends splitting winnings out of band.** Unfixable, and mostly harmless: the currency buys nothing. Net-profit ranking drives an alternating arrangement to ~0 for both parties. **Never ship a "total Cred staked" board** — volume is the one number that behaviour farms perfectly.
- **Throw while abstaining.** A thrower can hold zero position and let a confederate collect his teammates' stakes. Bounded at 500 Cred per game, in a game where nine people watch him feed and his Elo takes the real hit.
- **The hostage / abandon unwind.** Nobody can compel a Dota game. A player who hates their position can refuse to host; three hours later the abandon sweep cancels and everyone is refunded. Refunds make this EV-neutral (there is nothing to profit from), but a stake can be locked for 3–6 hours — **say so at bet time**, don't let someone discover it.
- **The spite bet.** A teammate's MAX on the long side dilutes the others' matched fraction. Bounded to one 100-Cred bet by the single-shot rule, and the money is returned rather than lost.
- **THE TRIPWIRE.** Every argument above rests on Cred being worthless. **The moment anyone proposes making Cred buy something real, the whole feature must be reconsidered from scratch.** That sentence belongs in CLAUDE.md, not in a design doc nobody rereads.

---

## Implementation plan

### 1. `prisma/schema.prisma` — models and columns

Add to **`model InhouseLobby`**:

```prisma
  // --- Betting (see the Inhouse betting section in CLAUDE.md) ---
  // Wagering closes here. Written ONCE, in the same data block as
  // `status: READY` — never by any other path, so unlike `startedAt` it is not
  // a timestamp an interested party can push forward (the predictionOpen
  // lesson: lock on something nobody can rewrite).
  betsCloseAt    DateTime?
  // null = this lobby has no bets and never will be swept.
  // PENDING (set by the first bet) | SETTLED | REFUNDED | REVERSED
  betSettlement  String?
  // The PLAYED game's own start, from OpenDota. Stamped inside applyResult's
  // existing COMPLETED claim so the lazy settlement resolver can enforce the
  // late-bet void from columns alone — the request that had BuiltResult in
  // hand is allowed to die.
  matchStartTime DateTime?
  // JSON userId → net Cred change, stamped once at settlement. Same contract
  // as eloDeltas: the room's post-game banner reads it instead of re-deriving.
  betDeltas      String    @default("{}")

  bets InhouseBet[]

  // The unsettled-pot sweeper probes betSettlement = "PENDING", which is true
  // of at most one lobby at a time — so a league that never bets pays one
  // index probe per resolver run.
  @@index([betSettlement])
```

New models (place beside the other `Inhouse*` models):

```prisma
// One wager per player per lobby, on their OWN team. IMMUTABLE once placed —
// no raise, no withdraw, no side switch. That is what makes @@unique the
// double-spend guard: exactly one debit path per (user, lobby), enforced
// identically on SQLite and Postgres.
model InhouseBet {
  id          String    @id @default(cuid())
  lobbyId     String
  userId      String
  // The side they were on when they bet. FROZEN: settlement compares it to the
  // post-teamFixes roster and VOIDs on a mismatch (see settleBets).
  team        Int
  stake       Int
  placedAt    DateTime  @default(now())
  // Written by the betting-window claim. An unconfirmed row never settles.
  confirmedAt DateTime?
  // WON | LOST | VOID_LINEUP | VOID_LATE | REFUNDED
  outcome     String?
  matched     Int?      // how much of the stake the other side actually covered
  payout      Int?      // net Cred delta at settlement
  settledAt   DateTime?

  lobby InhouseLobby @relation(fields: [lobbyId], references: [id], onDelete: Cascade)
  user  User         @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([lobbyId, userId])
  // Career conviction rolls (/players/[id], the Cred board).
  @@index([userId])
}

// Play-money balance. A MUTABLE column rather than a ledger SUM, deliberately
// against this repo's derive-don't-store idiom: the affordability test has to
// be re-asserted in the WHERE of the debit itself, and you cannot atomically
// re-assert a SUM over a ledger in one Prisma statement.
model InhouseCredit {
  id        String   @id @default(cuid())
  userId    String   @unique
  balance   Int      @default(500)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}

// Append-only receipt for every Cred movement. The balance above is the CLAIM;
// this is the provenance (the reason Bid and AdminAction exist). userId is a
// PLAIN STRING with NO relation — the AdminAction shape — because the record of
// what someone staked has to outlive their account.
model InhouseCreditEntry {
  id      String @id @default(cuid())
  userId  String
  delta   Int
  // GRANT | STAKE | RETURN | WIN | LOSS | REFUND | REVERSAL | FLOOR | ADJUST
  reason  String
  // Idempotence key, unique with reason: the bet id for wager legs,
  // "<userId>:<yyyy-mm-dd>" for the once-a-day floor, the userId for grants.
  refId   String
  lobbyId String?
  note    String?
  createdAt DateTime @default(now())

  @@unique([reason, refId])
  @@index([userId])
}
```

Add `bets InhouseBet[]`, `inhouseCredit InhouseCredit?` to `model User`.

*Why no `lineupFixed` column:* the lineup check compares `bet.team` to the persisted, post-`teamFixes` `InhouseLobbyPlayer.team`. Both are columns, so no `BuiltResult` field needs persisting for it.

### 2. `src/lib/constants.ts` — the tunables block

In the `// ---------- Inhouse ----------` section, after `INHOUSE`:

```ts
export const INHOUSE_BET_STATUS = { PENDING:"PENDING", SETTLED:"SETTLED",
  REFUNDED:"REFUNDED", REVERSED:"REVERSED" } as const;
export type InhouseBetSettlement = typeof INHOUSE_BET_STATUS[keyof typeof INHOUSE_BET_STATUS];

export const INHOUSE_BET_OUTCOME = { WON:"WON", LOST:"LOST",
  VOID_LINEUP:"VOID_LINEUP", VOID_LATE:"VOID_LATE", REFUNDED:"REFUNDED" } as const;

export const INHOUSE_BETS = {
  START_BALANCE: 500, MIN_STAKE: 10, MAX_STAKE: 100, STEP: 10,
  WINDOW_SECONDS: 45, FLOOR: 100, REAL_GAME_SECONDS: 600,
  TIER_CONTESTED: 200, TIER_HIGH: 500, TIER_MARQUEE: 800,
} as const;
```

Strings, not Prisma enums — SQLite has none, and `src/lib/constants.ts` is the source of truth for allowed values.

### 3. `src/lib/inhouse-bets.ts` — the pure lib (no `prisma` import)

```ts
export type BetRow = { userId: string; team: number; stake: number; placedAtMs: number };
export type BetOutcome = "WON" | "LOST" | "VOID_LINEUP" | "VOID_LATE";
export type SettledBet = { userId: string; stake: number; matched: number; outcome: BetOutcome; delta: number };
export type Settlement = { bets: SettledBet[]; pool1: number; pool2: number; matched: number; deltas: Record<string, number> };

/** Exactly-conserving largest-remainder split of `total` across weights. */
export function allocate(weights: { key: string; weight: number }[], total: number): Record<string, number>;

/** Live pot during the window: side totals + each bettor's covered amount. */
export function potView(bets: BetRow[]): {
  pool1: number; pool2: number; matched: number; coveredByUser: Record<string, number>;
};

/** Settlement. Voids are removed BEFORE the pools are computed — ordering is load-bearing. */
export function settleBets(input: {
  bets: BetRow[];
  rosterTeam: Map<string, number | null>;   // POST-teamFixes
  winnerTeam: number;
  matchStartMs: number | null;              // null ⇒ no late-bet void
}): Settlement;

/** Player-facing refusal string, or null. Called by the service AND the room. */
export function betGateError(o: {
  balance: number; stake: number; myTeam: number | null;
  lobbyStatus: string; betsCloseAtMs: number | null; nowMs: number; alreadyBet: boolean;
}): string | null;

export function potTier(total: number): "casual" | "contested" | "high" | "marquee";
export function tierLabel(t: ReturnType<typeof potTier>): string;
```

`src/lib/inhouse-bets.test.ts` — a randomised conservation property (`Σ deltas === 0` over 500 seeded pools), `allocate` exactness and the `userId` tiebreak, the void-before-pools ordering, zero-pool (`M === 0` ⇒ every stake returned, all deltas 0), and a `betGateError` table.

### 4. `src/lib/inhouse-bet-service.ts` — the DB layer

**`placeInhouseBet(viewer, stake)`**, returning `ActionResult`. `ensureCredAccount(viewer.id)` runs **outside** the transaction (upsert + a `GRANT` ledger row caught on P2002) so the transaction's first write is the debit:

```ts
class BetWindowError extends Error {}   // draft-service.ts:436 / PickRaceError pattern

try {
  return await prisma.$transaction(async (tx) => {
    const lobby = await tx.inhouseLobby.findFirst({
      where: { status: { in: [INHOUSE_STATUS.READY, INHOUSE_STATUS.IN_PROGRESS] } },
      include: { players: true },
    });
    const acct = await tx.inhouseCredit.findUnique({ where: { userId: viewer.id } });
    const mine = lobby?.players.find((p) => p.userId === viewer.id) ?? null;
    const gate = betGateError({ /* …read-time checks… */ });
    if (gate) return { ok: false as const, error: gate };

    await raceHook("inhouseBet.placeBet.beforeDebit");

    // WRITE 1 — the money claim. `balance: { gte: stake }` IS the guard: there
    // is no upstream single-winner claim on this row (two tabs, two devices and
    // the Discord deep-link all reach it), so an `if (bal < stake) return` above
    // a blind decrement is a documented overdraft on Postgres READ COMMITTED.
    const debit = await tx.inhouseCredit.updateMany({
      where: { userId: viewer.id, balance: { gte: stake } },
      data:  { balance: { decrement: stake } },
    });
    // The LAST legal return: nothing has been written yet.
    if (debit.count === 0) return { ok: false as const, error: "Not enough Cred" };

    // WRITE 2 — the wager. @@unique([lobbyId,userId]) makes a double-click one
    // bet; P2002 is caught OUTSIDE.
    const bet = await tx.inhouseBet.create({
      data: { lobbyId: lobby!.id, userId: viewer.id, team: mine!.team!, stake },
    });

    // WRITE 3 — re-assert the WINDOW and OWN-TEAM MEMBERSHIP at the write, via
    // relation filters (acceptMatch, inhouse-service.ts:311-318). Everything
    // checked above can be false by the time this lands: an admin cancel or the
    // 45s expiry is exactly what commits in that gap.
    const open = await tx.inhouseBet.updateMany({
      where: {
        id: bet.id,
        lobby: {
          status: { in: [INHOUSE_STATUS.READY, INHOUSE_STATUS.IN_PROGRESS] },
          betsCloseAt: { gt: new Date() },
          players: { some: { userId: viewer.id, team: mine!.team! } },
        },
      },
      data: { confirmedAt: new Date() },
    });
    // Past the first write: THROW. A resolved Prisma interactive-transaction
    // callback COMMITS, so a `return` here persists the debit it exists to undo.
    if (open.count === 0) throw new BetWindowError("Bets just closed on this game.");

    // WRITE 4 — arm the sweeper. Idempotent; count is deliberately ignored.
    await tx.inhouseLobby.updateMany({
      where: { id: lobby!.id, betSettlement: null },
      data:  { betSettlement: INHOUSE_BET_STATUS.PENDING },
    });

    // WRITE 5 — the receipt.
    await tx.inhouseCreditEntry.create({
      data: { userId: viewer.id, delta: -stake, reason: "STAKE",
              refId: bet.id, lobbyId: lobby!.id },
    });
    return { ok: true as const };
  });
} catch (e) {
  // OUTSIDE the callback on purpose — catching inside resolves the transaction
  // and commits the very writes the throw exists to roll back.
  if (e instanceof BetWindowError) return { ok: false as const, error: e.message };
  if ((e as { code?: string }).code === "P2002")
    return { ok: false as const, error: "You already have a bet on this game" };
  throw e;
}
```

**`settleInhouseBets(lobbyId): Promise<Settlement | null>`** — the claim + every write in **one** `$transaction` (bounded: ≤10 bets, ≤10 balance rows, ≤~25 ledger rows, no external calls), so a death rolls it all back and the sweeper retries cleanly:

```ts
class BetSettleError extends Error {}

return await prisma.$transaction(async (tx) => {
  // WRITE 1 — the settlement claim. Elects exactly one winner across the three
  // result paths AND the lazy sweeper, under concurrent unauthenticated pings.
  const claim = await tx.inhouseLobby.updateMany({
    where: { id: lobbyId,
             status: INHOUSE_STATUS.COMPLETED,
             betSettlement: INHOUSE_BET_STATUS.PENDING },
    data:  { betSettlement: INHOUSE_BET_STATUS.SETTLED },
  });
  if (claim.count === 0) return null;       // LAST legal return

  const lobby = await tx.inhouseLobby.findUniqueOrThrow({
    where: { id: lobbyId },
    include: { players: true, bets: { where: { confirmedAt: { not: null } } } },
  });
  if (lobby.winnerTeam == null) throw new BetSettleError("no winner");

  const s = settleBets({
    bets: lobby.bets.map(...),
    rosterTeam: new Map(lobby.players.map((p) => [p.userId, p.team])), // POST-teamFixes
    winnerTeam: lobby.winnerTeam,
    matchStartMs: lobby.matchStartTime?.getTime() ?? null,
  });

  for (const b of s.bets) {
    await tx.inhouseBet.update({ where: { lobbyId_userId: { lobbyId, userId: b.userId } },
      data: { outcome: b.outcome, matched: b.matched, payout: b.delta, settledAt: new Date() } });
    // BLIND increment, DELIBERATELY: the claim above already elected one
    // winner, so there is no rival. Same reasoning as Team.budget
    // (draft-service.ts:90-93). Do NOT "fix" this into a conditional write —
    // that would make settlement non-idempotent in the wrong direction.
    await tx.inhouseCredit.update({ where: { userId: b.userId },
      data: { balance: { increment: b.stake + b.delta } } });          // stake back + net
    await tx.inhouseCreditEntry.createMany({ data: [ /* RETURN / WIN / LOSS legs */ ] });
  }
  // Floor top-ups: durationSecs >= REAL_GAME_SECONDS, participant below FLOOR,
  // ledger refId "<userId>:<utcDate>" — the @@unique IS the once-a-day guard.
  await applyFloor(tx, lobby, s);
  await tx.inhouseLobby.update({ where: { id: lobbyId },
    data: { betDeltas: JSON.stringify(s.deltas) } });
  return s;
});
```

**`resolveUnsettledBets(): Promise<boolean>`** — one indexed probe, three branches:

| Lobby state | Action | Claim |
|---|---|---|
| `betSettlement: PENDING`, `status: COMPLETED` | settle | above |
| `betSettlement: PENDING`, `status: CANCELLED` | refund every confirmed bet in full | `→ REFUNDED` |
| `betSettlement: SETTLED`, `status: CANCELLED` | reverse (claw back WIN, restore LOSS; net zero vs. pre-game) | `→ REVERSED` |

**Nothing is added to `cancelLobby`, `failReadyCheck`, `resolveAbandonedLobby` or `voidLastResult` for refunds** — all four already flip the lobby to a state one of the three branches recognises. `failReadyCheck` needs no handling at all: the window opens at READY, four phases later, so a pot can never exist there.

Also here: `adjustCred(adminId, userId, delta, note)` (`ADJUST` reason, through `logAdminAction`) — the escape hatch every other admin surface has.

### 5. `src/lib/inhouse-service.ts` — the edits, in order

1. **The READY transition** — extract `readyTransitionData(nowMs)` returning `{ status: READY, pickTeam: null, pickEndsAt: null, betsCloseAt: new Date(now + WINDOW_SECONDS*1000) }` and spread it at **both** `status: READY` write sites: `applyPick`'s advance claim (~:698) and `restoreLostPickTurn` (~:742). Miss the second and a lobby recovered through the lost-turn path arrives with betting silently off and no error anywhere — the same shape as the standin announcement's four call sites. One nullable timestamp in an existing claim's `data`: zero extra statements, zero extra failure paths, and if the claim loses, nothing happened.
2. **`applyResult`'s claim `data`** gains `matchStartTime: new Date(r.startTime * 1000)`.
3. **Settlement call site — the order is load-bearing:**
   ```
   1. COMPLETED claim              (existing; now stamps matchStartTime)
   2. teamFixes loop               (existing)  ← the truth about who played which side
   3. NEW: settlement              try { s = await settleInhouseBets(lobbyId) } catch { log }
   4. full-history Elo scan + eloDeltas stamp   (existing)
   5. stampResultChange()          (existing)
   6. Discord result send          (existing; carries the slips from `s`)
   ```
   **After** step 2 because `teamFixes` rewrites the exact column the lineup void reads. **Before** step 4 because that scan is the slow unwindowed one and the `eloDeltas` write beneath it is the one write in the function that is *not* a claim — money must not sit downstream of it. Wrapped in try/catch so a bet bug can never stop the Elo stamp, the cursor, or the announcement; the sweeper retries.
4. **`cancelLobby`** — the `IN_PROGRESS` branch of its claim WHERE gains `bets: { none: { confirmedAt: { not: null } } }` unless `force` is passed. `force` writes an `AdminAction` and posts a Discord alert.
5. **Both resolver chains** gain `try { await resolveUnsettledBets() } catch (e) { console.error(e) }` immediately after `resolveAbandonedLobby()` — in `getInhouseState` (~:1646) and in `result-sync-service.ts`'s `syncInhouse`.
6. **`result-sync-service.ts`: hoist the sweeper ABOVE the `!active && queued === 0` early return** (beside the existing `syncInhouseBoard()` call, and for the same stated reason). That branch is precisely "game over, everyone left, nobody is polling" — the state a stranded pot lives in.
7. **`getInhouseState` payload.** `lobby.pot = { closesAt, pool1, pool2, matched, slips: [{userId, name, team, stake, covered}], tier }` (public — the slips are the product). `me.cred` and `me.myBet`, fetched **only** when `myLobbyPlayer` exists or `lastResult` exists (the poll path is budgeted). `lastResult.credDelta` is read from the `betDeltas` JSON on the row it already fetches — zero extra queries, the `eloDeltas` precedent exactly. Add `canBet` to the `me` block, computed server-side from status + membership + `betsCloseAt`, like `canAccept`/`canStart`.

### 6. `src/app/api/inhouse/route.ts`

One new `case "bet": res = await placeInhouseBet(user, Number(body.stake)); break;`. DB-bound, so it gets `ROOM_ACTION_TIMEOUT_MS` (15s) automatically by **not** being added to `INHOUSE_SCAN_ACTIONS`. Inherits the per-IP speed bump, the 401 gate and the `syncBoard: false` reply. Add `force` to the `cancel` case.

### 7. `src/components/inhouse-room.tsx` — UI

- New `<PotPanel>` component, rendered as the **first** block of `ReadyView`'s body, **directly above `GameSetupCard`** — the panel must sit above the thing that pulls people into the Dota client, not below it — and read-only in `InProgressView`.
- A compact fixed clock bar at `top-20` following the existing `useBannerOffscreen` contract (same as the other three phases), so READY finally has a clock.
- Controls: one-tap chips `10 / 25 / 50 / MAX` plus `COVER <n> →` (stakes exactly the gap, capped at `MAX_STAKE` and balance). **Never a text input** — a bet that needs typing does not happen. `buttonClasses` (mobile-first `h-11 sm:h-10`), `TAP_SAFE`/`textLink()` for links.
- Countdown is a `SecondsClock` **leaf** so only the clock text re-renders each 250ms.
- **It must ride the existing `act()`** — `room-source-guards.test.ts` asserts exactly two `issueSequence(` sites and two `playChime()` sites per room file and fails any `fetch(` without a `signal:`. Widen `ReadyView`'s `act` prop to `(body) => Promise<boolean>` (the admin cancel/void buttons already do this).
- **No new chime and no new title flag** — `teams-ready` already rings at exactly this instant.
- **Never report a `TimeoutError` as a failed bet.** `act()`'s catch already branches on it; a false "your bet didn't go through" beside a balance that silently dropped is the worst thing a money feature can show.
- **No local optimistic balance.** `apply()` is the only writer of room state; a local copy would survive a payload the sequence gate discarded.
- Grid rules: `grid-cols-1` explicitly on the ordinary responsive grid; `min-w-0` on flex children; `overflow-hidden` on any card wrapping a scroller.

### 8. `src/app/inhouse/page.tsx`

Add a **Cred** column to the existing `LadderCard` (same card, same band) ranked on **net betting profit** — `Σ ledger deltas over {STAKE, RETURN, WIN, LOSS, REFUND, REVERSAL}`, excluding `GRANT`, `FLOOR` and `ADJUST`. Add a `YourStanding` Cred line. Do **not** insert a new card above the Elo ladder — the page order is already litigated in CLAUDE.md and that is the exact mistake that was fixed. If a standalone board is wanted, it goes **below** the ladder, above Recent results, in its own `<Suspense fallback={<CardSkeleton/>}>`.

### 9. Discord

- **Result post** (`inhouseResultMessage`, `sendInhouseDiscordMessage` → the **ALERT** webhook, never the board's) gains a slips block. Every name through `escapeDiscordText`. No `MentionAllowlist` — the message names no action. No emoji.
  ```
  Dire win 41–28 · 38:12 · MVP Kessler (Puck) 12/2/16
  Pot 400 · HIGH STAKES · fully covered
    Radiant  Kessler 100 → 0    Roo 50 → 0
    Dire     Dooley 100 → 200   Mig 60 → 120
  Biggest cover: Dooley 100
  ```
- **Pinned board** (`inhouse-board.ts`, the BOARD webhook): add the pot to the **LIVE (IN_PROGRESS)** state only, where it is frozen — `PRICED 400 CRED ON THE LINE`. Zero extra PATCHes. **Never put a live pot or a countdown in a digest** — the digest excludes the clock precisely so a motionless queue costs zero edits; a moving figure burns one PATCH every `BOARD_MIN_SECONDS` forever. No emoji.
- **Admin alert** on a forced cancel or a void with a live pot, naming the admin and the pot.

### 10. Tests

- **Unit** — `src/lib/inhouse-bets.test.ts` (above).
- **Integration** — `test/integration/inhouse-bets.itest.ts`: placement gates; refusal to bet on the other team; window closed; settlement end-to-end matching the three worked examples; `VOID_LINEUP` (stage a `teamFixes` swap, assert the swapper is refunded and the other eight settle from the *recomputed* pools); `VOID_LATE`; refund on `cancelLobby`, on `resolveAbandonedLobby` and on `failReadyCheck` — **all via the sweeper, with no edits to those functions**; reversal after `voidLastResult`; the forced-cancel guard; floor top-up paying once and refusing a second time the same UTC day; refusing on a sub-600s game; and a randomised bet/settle/cancel/void sequence asserting `balance === 500 + Σ ledger deltas` for every user. Plus: `runResultSync` settles a stranded pot **on the `!active && queued === 0` early-return path**.
- **pg / race** (`npm run pg:up`, `PG_TEST_URL`, `npm run test:pg`, then **`npm run pg:down`**): `raceN(2, () => placeInhouseBet(u, 100))` against a balance of 100, looped, asserting `balance + Σ stakes === 100` — **RACED, not staged**; staging is caught by the function's own read-time check and passes against a blind decrement, which is how four tests here already went false-green. `raceN(4, resolveUnsettledBets)` asserting one payout. A `raceHook("inhouseBet.placeBet.beforeDebit")` seam committing an admin cancel between the read and the write, `describe.skipIf(!ON_POSTGRES)`, asserting `fired === true`.
- **e2e** — extend `e2e/zz4-inhouse.spec.ts`: reach READY with the nine API-driven players, place a bet in the browser, assert the pot renders, the mobile no-horizontal-overflow tripwire, and zero page errors.
- **Mutation ratchet** — add `"src/lib/inhouse-bet-service.ts"` to `FILES` in `scripts/mutation-guard.mjs`, then a **full** `npm run test:mutation:discover` (a `--only` sweep refuses to write the baseline) and commit the new baseline. It **will** see: the `balance: { gte: stake }` debit, the `confirmedAt + lobby{…}` window claim (nested relation filters are state — `acceptMatch::acceptedAt+lobby#1` is already in the baseline), the `betSettlement` claim, and `cancelLobby`'s new `bets: { none: … }` predicate.
  **It will NOT see** — verify each by sabotaging the guard by hand and confirming the test goes red: the `@@unique([lobbyId, userId])` P2002 double-bet catch, the `@@unique([reason, refId])` once-a-day floor, `betGateError`'s early returns, and every count-check-then-throw. Do not read "50/50 protected" as coverage of those.
- **`test/integration/factories.ts`** — add `inhouseCreditEntry`, `inhouseBet`, `inhouseCredit` to `resetDb`, **children first, before `inhouseLobby`/`user`**. It is a hand-maintained list and `adminAction` is already missing from it — fix that in the same pass; a no-FK table not listed leaks rows between tests, which for money math means a green suite measuring the previous test's balances.
- **`prisma/seed.ts`** — no change needed; the column default funds every account.

### 11. `CLAUDE.md` — the entry to write

A new `## Inhouse betting (done)` section, after the Inhouse section, carrying: the ownership rule (own team only, ten players only, never spectators, and *why* — the proxy, not the bettor's honesty); **the tripwire** ("every safety argument here rests on Cred being worthless — the moment anyone proposes making Cred buy something real, reconsider the feature from scratch"); the window's two write sites and the source guard on them; the settlement order in `applyResult` (after `teamFixes`, before the Elo scan) and why each boundary matters; the "any post-claim check must be computable from COLUMNS" rule, generalised — it is why `matchStartTime` is persisted; the deliberate deviations (a mutable balance column against derive-don't-store; the blind `{ increment }` under the settlement claim, with a **do not "fix" this** note); the one-refund-rule design (`resolveUnsettledBets`, four terminal paths, zero edits to hardened claims); why the bet resolver alone is wrapped in try/catch; why the board carries the pot only in the frozen LIVE state; and the flat refusal of stake-weighted Elo with the four-call-site blast radius.

---

## Risks and open questions

**1. Will the weaker side ever stake? (Decide the kill criterion before writing code.)** Even money means the side that thinks it's behind is −EV, so a rational weak side abstains and `M` collapses toward zero. My argument is that a snake-drafted 5v5 sits near a coin flip and that a small pot on a lopsided night is *signal*, not failure — but that is a claim about behaviour, not code. **Agree a trigger now:** if median matched pool is under 50 Cred across the first 20 games, the answer is *not* to add odds (that reintroduces a house, a rake, model arbitrage and the MMR-sandbag exploit at a stroke) — it is to check whether the drafts are actually close and, if they are, to conclude the feature does not fit and cut it.

**2. Will ten people look at their browser for 45 seconds in the phase where they are alt-tabbing to Dota?** Every one of the three designs quietly bets the whole feature on this, and none can settle it from inside. The mitigations are in the plan (panel above `GameSetupCard`, one-tap chips only, a real clock, slips visible the instant the first lands) and they are behavioural, not architectural. **Agree a second trigger:** if median participation is under 5 of 10 over 20 games, delete the economy — there is no second version of this that works when nobody presses the button.

**3. The one edit to hardened code: should `cancelLobby` be gated at all?** Today an admin can cancel a live `IN_PROGRESS` game, which under any betting design is an undo for a losing bet. My plan adds a relation filter plus an explicit `force` (with `DangerSubmit`, an `AdminAction` and a Discord alert). The alternative is to leave `cancelLobby` completely untouched and rely purely on visibility. I recommend the guard — it is the `reopenMatch` pattern, it is a claim the ratchet can grade, and it costs three lines — but it touches a function that currently has exactly one clean claim, and that is a decision worth making deliberately rather than discovering in review.

**Minor, decide in passing:** the currency name (**Cred**), `START_BALANCE` 500 / `MAX_STAKE` 100 (five max bets, flat forever — the flat cap is deliberate and should not become a percentage of balance), and whether the Cred number belongs as a column on the existing ladder card or as its own card below it.