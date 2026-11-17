import { sendDiscordMessage } from "./discord";
import { claimThrottle } from "./settings";
import { STANDIN_OFFER_PING_THROTTLE_SECONDS } from "./standin-offer";
import type { StandinOfferResult } from "./standin-offer-service";

/**
 * The one Discord post a new offer can send: that side's captain, told that
 * someone can play. Called by an action after `offerToStandIn` has stored
 * the offer, never inside a transaction. The claim lets the first offer
 * through and holds the rest of the window, so a list filling up is one
 * ping; it is claimed last, after the write it follows. Best-effort: the
 * offer stands, and the captain's card lists it either way.
 */
export async function sendStandinOfferPost(
  result: StandinOfferResult,
): Promise<void> {
  if (!result.ok || !result.post) return;
  try {
    if (
      await claimThrottle(
        result.post.throttleKey,
        STANDIN_OFFER_PING_THROTTLE_SECONDS,
        Date.now(),
      )
    ) {
      await sendDiscordMessage(result.post.announcement, result.post.mentions);
    }
  } catch {
    // Never let a post undo or fail the offer.
  }
}
