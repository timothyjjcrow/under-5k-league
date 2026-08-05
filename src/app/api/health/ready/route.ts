import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** User-facing readiness: the application is not usable without its database. */
export async function readinessResponse(
  // Explicit Prisma.sql invocation keeps the default probe a normal awaited
  // call rather than depending on tagged-template route transforms.
  probe: () => Promise<unknown> = () =>
    prisma.$queryRaw(Prisma.sql`SELECT 1`),
) {
  try {
    await probe();
    return NextResponse.json(
      { ok: true, status: "ready" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { ok: false, status: "unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}

export function GET() {
  return readinessResponse();
}
