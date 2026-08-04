import { NextRequest, NextResponse } from "next/server";
import { destroySession } from "@/lib/auth";

// Logging out is a state change, so it must NOT be triggerable by a cross-site
// GET (<img src=".../logout">, link prefetch) — hence POST-only — nor by a
// cross-site POST form, hence the same-origin Origin check. 303 makes the
// browser follow the redirect as a GET (a 307 would re-POST). The destination
// confirms the state change instead of silently dropping the user at home.
export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return NextResponse.json({ error: "cross-origin" }, { status: 403 });
      }
    } catch {
      // Browsers can send `Origin: null`; arbitrary clients can send malformed
      // values. Neither proves same-origin, and neither should turn logout into
      // a 500.
      return NextResponse.json({ error: "cross-origin" }, { status: 403 });
    }
  }
  await destroySession();
  return NextResponse.redirect(new URL("/login?signedOut=1", req.url), 303);
}
