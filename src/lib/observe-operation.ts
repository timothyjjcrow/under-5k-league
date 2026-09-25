type Observation = { elapsedMs: number; failed: boolean; error?: unknown };

/** Optional observers cannot replace the result or rejection of a domain call. */
export async function observeOperation<T>(
  operation: () => Promise<T>,
  observer: (observation: Observation) => Promise<void>,
): Promise<T> {
  const started = performance.now();
  let failed = false;
  let failure: unknown;
  try {
    return await operation();
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    try {
      await observer({ elapsedMs: performance.now() - started, failed, error: failure });
    } catch {
      // The observer is optional; the operation's outcome is authoritative.
    }
  }
}
