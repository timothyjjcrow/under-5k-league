/**
 * One browser request's abort signal: it aborts after `timeoutMs`, or as soon
 * as any `cancels` signal aborts (an unmount, a newer action), whichever
 * comes first. Call `done()` once the response body has been read: it stops
 * the timer and unhooks the cancels, so a long-lived cancel signal (a
 * component's mount) never collects one listener per request.
 *
 * It uses only AbortController and setTimeout, never `AbortSignal.any`
 * (Safari before 17.4 has none, and calling it there throws, so every read
 * of a panel built on it failed) or `AbortSignal.timeout`.
 */
export function requestSignal(
  timeoutMs: number,
  ...cancels: (AbortSignal | undefined)[]
): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const hooked: AbortSignal[] = [];
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  const done = () => {
    clearTimeout(timer);
    for (const signal of hooked) signal.removeEventListener("abort", abort);
    hooked.length = 0;
  };
  for (const cancel of cancels) {
    if (!cancel) continue;
    if (cancel.aborted) {
      done();
      abort();
      break;
    }
    cancel.addEventListener("abort", abort);
    hooked.push(cancel);
  }
  return { signal: controller.signal, done };
}
