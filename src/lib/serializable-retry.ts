// Retrying a Serializable transaction that Postgres aborted.
//
// Under SERIALIZABLE, Postgres aborts one side of a read/write conflict
// (`isSerializationConflict`), and the same work can succeed against a fresh
// snapshot. WAIT before that retry. The loser is often cancelled while the
// winner is still committing: the winner has passed its own conflict check
// but is still flushing its commit record. A retry that takes its snapshot
// inside that window can't see the winner's rows yet, reads them as in
// flight, and is cancelled against the same winner again ("Canceled on
// conflict out to pivot …, during read"). The ready check's last two answers
// lost three immediate retries in a row that way (CI run 37423778573);
// slowing commits on the test database reproduces it on demand
// (concurrency-and-testing.md).
//
// So each retry waits a random time in the upper half of a window that
// doubles. The floor gives the winner's commit time to land; the jitter keeps
// two losers from retrying in step.

import { isSerializationConflict } from "./prisma-errors";

/** Tries in all, unless the caller asks for more. */
const DEFAULT_ATTEMPTS = 3;
/** The first retry's window: it waits 5–10 ms. Each later window doubles… */
const FIRST_WINDOW_MS = 10;
/** …up to this, so a long retry budget never sleeps for seconds. */
const MAX_WINDOW_MS = 250;

/**
 * How long to wait before retry `retry` (1 for the first), given a `jitter`
 * in [0, 1): between half and all of a window that starts at 10 ms and
 * doubles with each retry, capped at 250 ms.
 */
export function serializableRetryDelayMs(retry: number, jitter: number): number {
  const window = Math.min(MAX_WINDOW_MS, FIRST_WINDOW_MS * 2 ** (retry - 1));
  const unit = Math.min(1, Math.max(0, jitter));
  return Math.round(window * (0.5 + 0.5 * unit));
}

/**
 * Run `run`, one whole Serializable transaction, again after an ordinary SSI
 * abort: up to `attempts` tries in all, waiting `serializableRetryDelayMs`
 * before each retry. Every try is a fresh transaction that re-reads and
 * re-judges everything, so a retry never acts on what the aborted one read.
 * Any other error, and the last try's conflict, is rethrown for the caller to
 * turn into its own "reload and try again".
 */
export async function retrySerializable<T>(
  run: () => Promise<T>,
  { attempts = DEFAULT_ATTEMPTS }: { attempts?: number } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isSerializationConflict(error) || attempt >= attempts) throw error;
    }
    const delayMs = serializableRetryDelayMs(attempt, Math.random());
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
}
