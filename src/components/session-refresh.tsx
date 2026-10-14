"use client";

import { useEffect } from "react";

const REFRESH_TIMEOUT_MS = 10_000;

// Mounted by the root layout only when the server found the session cookie
// due its weekly re-issue (getSessionRefreshDue): one POST, best-effort. A
// failed or lost call changes nothing; the next page load asks again while
// the cookie is still due. Renders nothing.
//
// Log out is a form post, and a refresh still in flight could otherwise land
// after the logout cleared the cookie and set it again. Any form submit
// therefore aborts the call first (harmless for other forms: the next page
// load asks again). The removed proxy re-issued on the page's own response,
// so it raced nothing.
export function SessionRefresh() {
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    const stop = () => controller.abort();
    document.addEventListener("submit", stop, true);
    fetch("/api/auth/refresh", { method: "POST", signal: controller.signal })
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        document.removeEventListener("submit", stop, true);
      });
    return () => {
      clearTimeout(timer);
      document.removeEventListener("submit", stop, true);
      controller.abort();
    };
  }, []);
  return null;
}
