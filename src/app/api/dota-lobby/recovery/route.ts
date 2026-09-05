import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { guardJsonMutation, readBoundedJsonObject } from "@/lib/json-mutation";
import { recoverableInhouseBotLobby } from "@/lib/dota-lobby-service";
import { UserFacingError } from "@/lib/user-facing-error";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = guardJsonMutation(req);
  if (guard) return guard;
  const viewer = await getSessionUser();
  if (!viewer || viewer.role !== "ADMIN")
    return NextResponse.json(
      { error: viewer ? "Admins only." : "Sign in to check bot recovery." },
      { status: viewer ? 403 : 401 },
    );
  const parsed = await readBoundedJsonObject(req);
  if (!parsed.ok) return parsed.response;
  if (!rateLimit(`dota-lobby-recovery:${viewer.id}`, { limit: 12, windowMs: 60_000 }, Date.now()).allowed)
    return NextResponse.json(
      { error: "Please wait before checking bot recovery again." },
      { status: 429 },
    );
  try {
    return NextResponse.json(await recoverableInhouseBotLobby(viewer), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof UserFacingError ? error.message : "Bot recovery is temporarily unavailable." },
      { status: 400 },
    );
  }
}
