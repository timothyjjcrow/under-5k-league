/** Coalesce pending work only. Each key must include every scope and revision
 * that affects its result; this is process-local, not a distributed lock. */
export function createSingleFlight<T>(
  onRefresh?: (shared: boolean) => void,
  maxPending = 256,
) {
  const pending = new Map<string, Promise<T>>();
  return function singleFlight(key: string, load: () => Promise<T>): Promise<T> {
    const existing = pending.get(key);
    onRefresh?.(!!existing);
    if (existing) return existing;
    const promise = Promise.resolve().then(load);
    // Bound bookkeeping even when many scopes/revisions arrive at once. An
    // overflow still completes normally; only its coalescing is skipped.
    if (pending.size >= maxPending) return promise;
    pending.set(key, promise);
    const clear = () => {
      if (pending.get(key) === promise) pending.delete(key);
    };
    // Use both handlers rather than discarding a rejecting finally promise.
    void promise.then(clear, clear);
    return promise;
  };
}
