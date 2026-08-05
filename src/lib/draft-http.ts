/**
 * Untrusted request metadata carried by every live-auction request.
 *
 * The room is deliberately long-lived: captains park it before Start and may
 * keep it open through an abort/restart or even an active-season switch. That
 * makes "whatever season/lot is current when the click arrives" the wrong
 * target. These parsers give route handlers one strict, shared contract and
 * let stale requests fail with 409 instead of being replayed onto new state.
 */

export type DraftTurnExpectation = {
  draftVersion: number;
  nominatorTeamId: string;
  nominationEndsAt: number;
};

export type DraftLotExpectation = {
  draftVersion: number;
  nominatedUserId: string;
  currentBid: number;
  currentBidTeamId: string;
  bidEndsAt: number;
};

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function objectBody(body: unknown): Record<string, unknown> {
  return body != null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function safeInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function requireExpectedDraftSeason(
  body: unknown,
  activeSeasonId: string,
): ParseResult<string> {
  const seasonId = nonEmptyString(objectBody(body).seasonId);
  if (!seasonId || seasonId !== activeSeasonId) {
    return {
      ok: false,
      error:
        "The active season changed while this draft room was open — reload before acting.",
    };
  }
  return { ok: true, value: seasonId };
}

export function parseDraftTurnExpectation(
  body: unknown,
): ParseResult<DraftTurnExpectation> {
  const value = objectBody(body);
  const draftVersion = safeInteger(value.draftVersion);
  const nominatorTeamId = nonEmptyString(value.nominatorTeamId);
  const nominationEndsAt = safeInteger(value.nominationEndsAt);
  if (
    draftVersion == null ||
    draftVersion <= 0 ||
    !nominatorTeamId ||
    nominationEndsAt == null ||
    nominationEndsAt <= 0
  ) {
    return {
      ok: false,
      error: "The nomination turn is out of date — wait for the room to refresh.",
    };
  }
  return {
    ok: true,
    value: { draftVersion, nominatorTeamId, nominationEndsAt },
  };
}

export function parseDraftLotExpectation(
  body: unknown,
): ParseResult<DraftLotExpectation> {
  const value = objectBody(body);
  const draftVersion = safeInteger(value.draftVersion);
  const nominatedUserId = nonEmptyString(value.nominatedUserId);
  const currentBid = safeInteger(value.currentBid);
  const currentBidTeamId = nonEmptyString(value.currentBidTeamId);
  const bidEndsAt = safeInteger(value.bidEndsAt);
  if (
    draftVersion == null ||
    draftVersion <= 0 ||
    !nominatedUserId ||
    currentBid == null ||
    currentBid < 0 ||
    !currentBidTeamId ||
    bidEndsAt == null ||
    bidEndsAt <= 0
  ) {
    return {
      ok: false,
      error: "The auction lot is out of date — wait for the room to refresh.",
    };
  }
  return {
    ok: true,
    value: {
      draftVersion,
      nominatedUserId,
      currentBid,
      currentBidTeamId,
      bidEndsAt,
    },
  };
}

/** Race/stale-state rejections are conflicts, not invalid-input failures. */
export function draftActionErrorStatus(error: string): 400 | 409 {
  return /changed|out of date|another bid|closed/i.test(error) ? 409 : 400;
}
