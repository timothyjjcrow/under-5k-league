import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import { getDraftState } from "@/lib/draft-service";

export const dynamic = "force-dynamic";

// Polled by the draft room. Also lazily resolves any expired nomination so the
// auction advances even when nobody is actively clicking.
export async function POST() {
  const [user, season] = await Promise.all([
    getSessionUser(),
    getActiveSeason(),
  ]);
  if (!season) {
    return NextResponse.json({ error: "No active season" }, { status: 404 });
  }
  const state = await getDraftState(season.id, user);
  return NextResponse.json(state);
}
