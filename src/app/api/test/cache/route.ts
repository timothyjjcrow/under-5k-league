import { revalidatePath, revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { stampResultChange } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Fixture-only cache boundary. Browser suites rewrite their isolated database
 * directly while intentionally reusing one Next dev server; without an
 * explicit expiry, a previous fixture's all-time stats can leak into the next
 * lifecycle state. This route is unreachable in production even if the path
 * is guessed.
 */
export async function POST() {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (
    process.env.NODE_ENV === "production" ||
    process.env.ALLOW_DEV_LOGIN !== "true" ||
    !/(?:e2e|fixture)/i.test(databaseUrl)
  ) {
    return new NextResponse(null, { status: 404 });
  }
  // Fixture writers bypass domain commands. Fence pending work from the
  // previous fixture as well as expiring persistent Next cache entries.
  await stampResultChange();
  revalidateTag("games", { expire: 0 });
  revalidatePath("/", "layout");
  return NextResponse.json({ ok: true });
}
