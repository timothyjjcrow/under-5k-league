/**
 * A test-only fault-injection seam for the guarded claims.
 *
 * WHY THIS EXISTS. Most of this codebase's concurrency guards are
 * `updateMany({ where: { …state } })` writes whose WHERE predicate re-asserts
 * something read earlier (see CLAUDE.md, "Concurrency: the two rules"). To
 * prove a guard works you have to produce ONE specific interleaving: the caller
 * READS, a rival COMMITS, and only then does the caller WRITE.
 *
 * `Promise.all` cannot steer that. Racing real service calls gets whatever
 * ordering the scheduler happens to give, and for several claims the losing
 * ordering simply never came up — so the mutation ratchet reported them
 * unprotected however many racers were thrown at them. Worse, a race test that
 * cannot produce the ordering still PASSES, which is the false-green this
 * codebase has been bitten by repeatedly.
 *
 * So the service yields at a labelled point, and the test decides what happens
 * there. The interleaving becomes deterministic instead of hoped-for.
 *
 * COST IN PRODUCTION: one null check. `hook` is never set outside tests —
 * `setRaceHook` throws otherwise, so this cannot be armed by accident or by a
 * misconfigured deploy.
 *
 * DEADLOCK WARNING for anyone writing one of these tests: the hook usually
 * fires INSIDE an open `prisma.$transaction`, and a rival write issued from the
 * hook runs on a DIFFERENT connection. If it touches a row the open transaction
 * has already written, it blocks on that row's lock while the transaction waits
 * on the hook — a hang, not a failure. Only touch rows the open transaction has
 * not yet written. (This is also why these tests are Postgres-only: SQLite pins
 * a single connection, so ANY rival write inside an open transaction hangs.)
 */

export type RaceHook = (label: string) => void | Promise<void>;

let hook: RaceHook | null = null;

/**
 * Yield to a test-installed hook. A no-op — and a single branch — in
 * production. Label these by `function:whatJustHappened` so a test reads as a
 * statement about the interleaving it is creating.
 */
export async function raceHook(label: string): Promise<void> {
  if (hook) await hook(label);
}

/**
 * Install (or clear, with null) the hook. TEST ONLY: this throws anywhere else,
 * so no code path in a running app can arm a seam that pauses a transaction
 * mid-flight. Always clear it in an `afterEach`.
 */
export function setRaceHook(next: RaceHook | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("setRaceHook is test-only");
  }
  hook = next;
}

/**
 * Fire `run` exactly once, the first time `label` is seen, then disarm.
 * Almost every test wants this: the rival mutation must land once, and the
 * hooked call site is usually reached again afterwards (a retry, a later pick),
 * where firing a second time would confuse the assertion.
 */
export function onceAt(label: string, run: () => Promise<void>): RaceHook {
  let fired = false;
  return async (seen) => {
    if (seen !== label || fired) return;
    fired = true;
    await run();
  };
}
