import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import { getDraftState, placeBid } from "@/lib/draft-service";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const season = await getActiveSeason();
  if (!season) return NextResponse.json({ error: "No active season" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const amount = Number(body.amount);

  const res = await placeBid(season.id, user, amount);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });

  const state = await getDraftState(season.id, user);
  return NextResponse.json(state);
}
