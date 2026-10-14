import { NextRequest, NextResponse } from "next/server";
import { refreshSessionCookie } from "@/lib/auth";
import { requireSameOrigin } from "@/lib/json-mutation";

export const dynamic = "force-dynamic";

// Keeps an active player signed in: re-issues a session more than a week old
// (same user, epoch and sign-in time; never past the 180-day cap). The page
// calls it only when getSessionRefreshDue says the cookie is due, so it runs
// about once per player per week. POST and same-origin like logout, because
// it sets the session cookie; it authorizes nothing and says nothing about the
// session, so the answer is the same empty 204 whether or not it re-issued.
export async function POST(req: NextRequest) {
  const invalidOrigin = requireSameOrigin(req);
  if (invalidOrigin) return invalidOrigin;
  await refreshSessionCookie();
  return new NextResponse(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
