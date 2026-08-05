const HOST_COOKIE_PREFIX = "__Host-";

/**
 * Production identity cookies use the browser-enforced __Host- prefix. A
 * sibling subdomain cannot forge one because prefixed cookies must be Secure,
 * host-only, and scoped to `/`. Development keeps ordinary names so local
 * HTTP remains usable.
 */
export function deploymentCookieName(
  baseName: string,
  production = process.env.NODE_ENV === "production",
): string {
  return production ? `${HOST_COOKIE_PREFIX}${baseName}` : baseName;
}

type CookieSetter = {
  set(
    name: string,
    value: string,
    options: {
      expires: Date;
      httpOnly: boolean;
      maxAge: number;
      path: string;
      sameSite: "lax";
      secure: boolean;
    },
  ): unknown;
};

/**
 * Expire an httpOnly identity/flow cookie with the attributes required for
 * browsers to accept a production `__Host-` Set-Cookie instruction.
 *
 * Next 16.3's generic `.delete()` serializes an expired cookie without
 * `Secure`. Browsers reject that header when the name has the `__Host-`
 * prefix, which would leave sessions and OAuth state alive. Setting an empty,
 * already-expired cookie explicitly also keeps the deletion path/domain tuple
 * identical to the original cookie.
 */
export function expireHttpOnlyCookie(
  cookieStore: CookieSetter,
  name: string,
  production = process.env.NODE_ENV === "production",
): void {
  cookieStore.set(name, "", {
    expires: new Date(0),
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "lax",
    secure: production,
  });
}
