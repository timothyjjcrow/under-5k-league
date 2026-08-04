/**
 * An expected domain failure whose fixed message is safe to serialize to a
 * user. Never construct this from provider, database, or caught-error text.
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

/**
 * Keep Server Action return values from becoming an exception-disclosure
 * channel. Unexpected failures get one stable operational code and a fixed
 * user response; the caught value is deliberately never logged or returned.
 */
export function actionErrorMessage(
  error: unknown,
  fallback: string,
  eventCode: string,
): string {
  if (error instanceof UserFacingError) return error.message;
  console.error(`[server-action:${eventCode}] unexpected failure`);
  return fallback;
}
