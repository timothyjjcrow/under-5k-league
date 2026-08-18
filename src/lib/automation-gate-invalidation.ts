import { revalidateTag } from "next/cache";
import { AUTOMATION_GATE_TAG } from "./automation-gate-constants";

/**
 * Cache expiry is an optimization signal, never the success boundary for a
 * domain mutation. Keep synchronous framework/context failures from replacing
 * an already-committed draft, inhouse, or maintenance response. Backend cache
 * work is queued by Next; the immutable hard wake remains the fallback.
 */
export function invalidateAutomationGateBestEffort(): void {
  try {
    revalidateTag(AUTOMATION_GATE_TAG, { expire: 0 });
  } catch {
    // A missed signal is bounded by the persisted runner's hard wake.
  }
}
