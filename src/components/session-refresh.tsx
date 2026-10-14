"use client";

import { useEffect } from "react";

const REFRESH_TIMEOUT_MS = 10_000;

// Mounted by the root layout only when the server found the session cookie
// due its weekly re-issue (getSessionRefreshDue): one POST, best-effort. A
// failed or lost call changes nothing; the next page load asks again while
// the cookie is still due. Renders nothing.
export function SessionRefresh() {
  useEffect(() => {
    fetch("/api/auth/refresh", {
      method: "POST",
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    }).catch(() => {});
  }, []);
  return null;
}
