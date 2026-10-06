// Invite credit, the small version (Tim's pick, 2026-10-06). A signed-up
// player's "Copy invite link" carries their tag (`/?ref=<their user id>`).
// The browser that opens it remembers whose link it was for 30 days, so a
// friend needn't join in one sitting, and when that friend signs up as a
// brand-new player the Discord signup post says who invited them. Nothing
// is stored: the public shout-out is the whole feature, and a stored
// recruiter count would be a schema change. These are the pure rules;
// InviteRefCapture remembers the tag, invite-ref-cookie.ts hands it to the
// signup action and inviterForSignup decides the credit.

/** The cookie that remembers whose invite link this browser opened. */
export const INVITE_REF_COOKIE = "ggd2l_ref";
/** How long a browser remembers it. */
export const INVITE_REF_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** A user id as the tag carries it: cuid or uuid shaped, nothing to encode. */
const REF_SHAPE = /^[A-Za-z0-9_-]{8,64}$/;

export function isInviteRef(value: unknown): value is string {
  return typeof value === "string" && REF_SHAPE.test(value);
}

/** The tag in a page's query string, or null. A repeated `ref` reads as no
 *  tag, as `singleSearchParam` reads any repeated key. */
export function inviteRefFromSearch(search: string): string | null {
  const values = new URLSearchParams(search).getAll("ref");
  return values.length === 1 && isInviteRef(values[0]) ? values[0] : null;
}

/** The query string without its `ref`, as "?…" or "", so a friend who shares
 *  the page they landed on shares the page, not someone else's tag. */
export function searchWithoutRef(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("ref");
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

/** The first link wins: a tag is remembered only when none already is. */
export function shouldRememberInviteRef(
  remembered: string | null,
  ref: string | null,
): boolean {
  return ref !== null && isInviteRef(ref) && !isInviteRef(remembered);
}

/** One cookie's value out of a `document.cookie` string, or null. */
export function cookieValue(cookies: string, name: string): string | null {
  for (const part of cookies.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) {
      return part.slice(at + 1).trim();
    }
  }
  return null;
}

/** What a player's "Copy invite link" copies: the site's own address,
 *  tagged when the player is signed up (`refId`), bare otherwise. */
export function inviteUrl(origin: string, refId?: string | null): string {
  return isInviteRef(refId) ? `${origin}/?ref=${refId}` : origin;
}

/**
 * Whether a signup earns its inviter a shout-out: only for a brand-new
 * player (no signup in any earlier season), only when the inviter is signed
 * up this season, and never for inviting yourself.
 */
export function inviteCreditApplies(input: {
  ref: string | null;
  newUserId: string;
  inviterSignedUp: boolean;
  newUserSignedUpBefore: boolean;
}): boolean {
  return (
    isInviteRef(input.ref) &&
    input.ref !== input.newUserId &&
    input.inviterSignedUp &&
    !input.newUserSignedUpBefore
  );
}
