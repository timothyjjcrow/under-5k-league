import { safeReturnPath } from "./return-path";

/**
 * What every signed-in-only server action answers a signed-out submit. A
 * sign-in can end while a page stays open, and the button pressed on it
 * then gets this; <ActionForm> turns it into a link back in.
 */
export const SIGN_IN_REQUIRED = "Sign in required";

/** The sign-in page, returning to `returnTo` when it is a safe local path. */
export function signInHref(returnTo: string | null | undefined): string {
  const next = safeReturnPath(returnTo);
  return next ? `/login?next=${encodeURIComponent(next)}` : "/login";
}
