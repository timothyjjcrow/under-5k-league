// Where a signed-out "Sign in with Steam to join" button goes.

import { safeReturnPath } from "./return-path";

/** Dev login (local and e2e only) adds a second way to sign in on /login. */
export function devLoginEnabled(): boolean {
  return process.env.ALLOW_DEV_LOGIN === "true";
}

/**
 * Steam is the league's only way to sign in, so a join button skips /login,
 * which would only ask for a second click on "Sign in through Steam", and
 * starts the Steam round trip itself; ?next= brings the player back to
 * `next` (the signup form, usually). When dev login is on, /login is where
 * both ways live, so the button goes there instead.
 *
 * Render the result as a plain <a>, never next/link: prefetching the Steam
 * route would start a sign-in and replace its state cookie. And keep
 * STEAM_SIGN_IN_NOTICE beside the button: skipping /login skips the notice
 * that was on it.
 */
export function steamSignInHref(
  next: string,
  devLogin: boolean = devLoginEnabled(),
): string {
  const path = safeReturnPath(next);
  // Slashes read fine in a query value and keep "/login?next=/me" familiar.
  const query =
    path && path !== "/"
      ? `?next=${encodeURIComponent(path).replace(/%2F/gi, "/")}`
      : "";
  return `${devLogin ? "/login" : "/api/auth/steam"}${query}`;
}

/**
 * What signing in with Steam shares, in one line: the collection notice for
 * every Steam button, /login's included.
 */
export const STEAM_SIGN_IN_NOTICE =
  "Your Steam name, avatar, profile link, medal and public matches (from OpenDota) go on your league profile. You sign in on Steam's own site, so we never see your password or email.";
