import { safePoolMetrics } from "./database-diagnostics";

/** Metrics may try to start a failed engine. Bound each observer's wait and
 * permit at most one outstanding engine sample, including after a timeout. */
export function createPoolMetricsReader(read: () => Promise<unknown>, timeoutMs = 250) {
  let pending: Promise<ReturnType<typeof safePoolMetrics> | null> | null = null;
  return async function readBounded() {
    if (!pending) {
      const issued = Promise.resolve().then(read).then(safePoolMetrics).catch(() => null);
      pending = issued;
      void issued.then(() => { if (pending === issued) pending = null; });
    }
    const issued = pending;
    return new Promise<ReturnType<typeof safePoolMetrics> | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      void issued.then((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  };
}
