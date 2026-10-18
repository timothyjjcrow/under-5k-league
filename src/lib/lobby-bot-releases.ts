/**
 * The lobby bot releases a closing action started and nobody waits on
 * (`releaseInhouseBotAfterClose` in dota-lobby-service.ts). A leaf module, so
 * the integration setup can settle them without loading the services. Held
 * on `globalThis`, like the status cache, so every copy of the module (a
 * process loads lib modules more than once) tracks the same releases.
 */
const STORE = Symbol.for("ggd2l.lobbyBotReleases");

function pending(): Set<Promise<void>> {
  const holder = globalThis as typeof globalThis & {
    [STORE]?: Set<Promise<void>>;
  };
  return (holder[STORE] ??= new Set());
}

/** Track one release until it settles. It must never reject. */
export function trackBotRelease(task: Promise<void>): void {
  const set = pending();
  set.add(task);
  void task.finally(() => set.delete(task));
}

/** Tests only: wait for every release started so far, and any they start. */
export async function settleInhouseBotReleases(): Promise<void> {
  const set = pending();
  while (set.size > 0) await Promise.all([...set]);
}
