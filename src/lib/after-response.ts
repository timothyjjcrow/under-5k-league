import { after } from "next/server";

/**
 * Run `task` after the HTTP response has been sent (Next's `after()`), so the
 * request that triggered it never waits on it: a captain whose poll or bid
 * closed the last lot gets their room back while Discord is still answering.
 * The platform keeps the function alive until the task settles, but a task can
 * still be lost if the instance dies, so hand this only work whose durable
 * state is already committed (the league announcement outbox, which the
 * minute worker drains, is the case it was written for).
 *
 * Outside a request scope (the automation worker's own tests, scripts, the
 * test suites) there is no response to wait for, so the task runs inline
 * before this resolves. Never throws: a failed task is swallowed, like every
 * best-effort send it wraps.
 */
export async function runAfterResponse(
  task: () => Promise<unknown>,
): Promise<void> {
  const safe = async () => {
    try {
      await task();
    } catch {
      // Best-effort by contract; the durable work is already committed.
    }
  };
  try {
    after(safe);
    return;
  } catch {
    // `after` throws outside a request scope; run the task now instead.
  }
  await safe();
}
