// The SQLite Durable Object that holds one league's alert state (alerts.ts).
// Each Worker has its own namespace and uses one object in it, named after
// its league. A plain class with fetch(): the Worker calls it once per
// unpaused minute, after the pass.
import {
  recordSchedulerEvent,
  type AlertEnv,
  type AlertEvent,
  type AlertStorage,
} from "./alerts";

/** The slice of DurableObjectState this uses (the app has no Workers types). */
export type AlertObjectState = {
  storage: AlertStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
};

function readEvent(value: unknown): AlertEvent | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.ok !== "boolean" || !Number.isSafeInteger(v.at) || (v.at as number) <= 0) {
    return null;
  }
  if (!(v.detail === undefined || v.detail === null || (typeof v.detail === "string" && v.detail.length <= 200))) {
    return null;
  }
  return { ok: v.ok, at: v.at as number, detail: (v.detail as string | null | undefined) ?? null };
}

export class SchedulerAlertState {
  constructor(
    private readonly state: AlertObjectState,
    private readonly env: AlertEnv,
    // A wrapper, so the runtime's fetch is never called with another `this`.
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    let event: AlertEvent | null = null;
    try {
      event = readEvent(await request.json());
    } catch {
      event = null;
    }
    if (!event) return new Response(null, { status: 400 });
    const accepted = event;
    // One event at a time, Discord post included: two overlapping minutes
    // must not both see "not yet alerted" and post twice. A post is bounded
    // at 10 s, well inside the 30 s this may hold the object.
    const result = await this.state.blockConcurrencyWhile(() =>
      recordSchedulerEvent(this.state.storage, this.env, accepted, this.fetcher),
    );
    return Response.json(result);
  }
}
