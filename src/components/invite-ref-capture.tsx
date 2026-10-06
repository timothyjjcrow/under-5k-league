"use client";

import { useEffect } from "react";
import {
  INVITE_REF_COOKIE,
  INVITE_REF_MAX_AGE_SECONDS,
  cookieValue,
  inviteRefFromSearch,
  searchWithoutRef,
  shouldRememberInviteRef,
} from "@/lib/invite-credit";

/**
 * Remembers whose invite link opened this browser (src/lib/invite-credit.ts)
 * and takes the tag out of the address bar. Mounted once in the root layout,
 * so a link to any page works.
 *
 * The cookie is written here, in the page, on purpose: a GET route that set
 * it would also run for an <img> pointing at it, so any picture URL on the
 * site (a logo, a news image) could claim the credit for whoever viewed it.
 */
export function InviteRefCapture() {
  useEffect(() => {
    const { search, pathname, hash, protocol } = window.location;
    const ref = inviteRefFromSearch(search);
    if (
      ref &&
      shouldRememberInviteRef(cookieValue(document.cookie, INVITE_REF_COOKIE), ref)
    ) {
      document.cookie =
        `${INVITE_REF_COOKIE}=${ref}; Max-Age=${INVITE_REF_MAX_AGE_SECONDS}; Path=/; SameSite=Lax` +
        (protocol === "https:" ? "; Secure" : "");
    }
    const clean = searchWithoutRef(search);
    if (clean !== search) {
      window.history.replaceState(null, "", `${pathname}${clean}${hash}`);
    }
  }, []);
  return null;
}
