import { cookies } from "next/headers";
import { INVITE_REF_COOKIE, isInviteRef } from "./invite-credit";

/**
 * This browser's invite tag, read once and forgotten: a new signup consumes
 * it whether or not it earns a credit, so the first link really is the last
 * word. Best-effort by design, since invite credit must never fail a signup:
 * no request scope (a script, a test) or a cookie store that refuses the
 * delete reads as no tag.
 */
export async function takeInviteRef(): Promise<string | null> {
  try {
    const store = await cookies();
    const raw = store.get(INVITE_REF_COOKIE)?.value ?? null;
    if (raw !== null) store.delete(INVITE_REF_COOKIE);
    return isInviteRef(raw) ? raw : null;
  } catch {
    return null;
  }
}
