/**
 * The lobby bot releases a closing action started and nobody waits on
 * (`releaseInhouseBotAfterClose` in dota-lobby-service.ts). A leaf module, so
 * the integration setup can settle them without loading the services. Held
 * on `globalThis`, like the status cache, so every copy of the module (a
 * process loads lib modules more than once) tracks the same releases.
 */
const STORE = Symbol.for("ggd2l.lobbyBotReleases");

type Releases = { pending: Set<Promise<void>>; started: number };

function releases(): Releases {
  const holder = globalThis as typeof globalThis & { [STORE]?: Releases };
  return (holder[STORE] ??= { pending: new Set(), started: 0 });
}

/** Track one release until it settles. It must never reject. */
export function trackBotRelease(task: Promise<void>): void {
  const store = releases();
  store.started += 1;
  store.pending.add(task);
  void task.finally(() => store.pending.delete(task));
}

/** Tests only: wait for every release started so far, and any they start. */
export async function settleInhouseBotReleases(): Promise<void> {
  const { pending } = releases();
  while (pending.size > 0) await Promise.all([...pending]);
}

/**
 * Tests only: how many releases this process has started. A close with no
 * bot configured must start none (it never reads the game either).
 */
export function inhouseBotReleasesStarted(): number {
  return releases().started;
}
