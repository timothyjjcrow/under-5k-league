import { createHash, timingSafeEqual } from "node:crypto";

const MIN_SECRET_LENGTH = 32;
const MAX_SECRET_LENGTH = 512;
const MAX_AUTHORIZATION_LENGTH = MAX_SECRET_LENGTH + "Bearer ".length;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Authenticate Vercel/external cron calls without exposing secret length in the
 * final comparison. The header is deliberately the only credential source:
 * query strings are logged widely and cookies would turn this into a browser
 * session boundary instead of a machine boundary.
 */
export function validCronBearer(
  authorization: string | null,
  configuredSecret: string | undefined,
): boolean {
  if (
    !authorization ||
    authorization.length > MAX_AUTHORIZATION_LENGTH ||
    !authorization.startsWith("Bearer ") ||
    authorization.slice("Bearer ".length).length === 0 ||
    /\s/.test(authorization.slice("Bearer ".length))
  ) {
    return false;
  }

  if (
    !configuredSecret ||
    configuredSecret.length < MIN_SECRET_LENGTH ||
    configuredSecret.length > MAX_SECRET_LENGTH ||
    /\s/.test(configuredSecret)
  ) {
    return false;
  }

  const supplied = authorization.slice("Bearer ".length);
  return timingSafeEqual(digest(supplied), digest(configuredSecret));
}
