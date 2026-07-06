import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import { getDraftState, nominatePlayer } from "@/lib/draft-service";

export const dynamic = "force-dynamic";

// Admin fallback: nominate the top available player for the team on the clock,
// so the draft keeps moving if a captain is away.
export async function POST() {
  const user = await getSessionUser();
  if (!user || user.role !== "ADMIN") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
  const season = await getActiveSeason();
  if (!season) return NextResponse.json({ error: "No active season" }, { status: 404 });

  const state = await getDraftState(season.id, user);
  if (!state) return NextResponse.json({ error: "No draft" }, { status: 404 });
  if (state.nominatedPlayer) {
    return NextResponse.json(
      { error: "A nomination is already in progress" },
      { status: 400 },
    );
  }
  const top = state.available[0];
  if (!top) {
    return NextResponse.json({ error: "No players available" }, { status: 400 });
  }

  const res = await nominatePlayer(season.id, user, top.userId, state.minBid);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });

  return NextResponse.json(await getDraftState(season.id, user));
}
