import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Process liveness only: deliberately no database or external-service work. */
export function GET() {
  return NextResponse.json(
    { ok: true, status: "live" },
    { headers: { "cache-control": "no-store" } },
  );
}
