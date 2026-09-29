import { NextResponse, type NextRequest } from "next/server";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getActiveSeason } from "@/lib/season";
import { recapDestination } from "@/lib/recap";
import { singleSearchParam } from "@/lib/search-params";

// A finished season's recap (champion, bracket, stat strip, awards) lives on
// its own season page, /seasons/<id>. This route only redirects, so every old
// /recap and /recap?season=<id> link keeps working, including the champion
// posts already sitting in Discord. It is a route handler rather than a page
// so the redirect is a real HTTP one that link previews follow too.
export async function GET(request: NextRequest) {
  const values = request.nextUrl.searchParams.getAll("season");
  // A repeated key is a malformed link: 404, never a guess at which season.
  const seasonId = singleSearchParam(values.length > 1 ? values : values[0]);
  if (seasonId === null) notFound();

  let destination: string;
  if (seasonId) {
    const requested = await prisma.season.findUnique({
      where: { id: seasonId },
      select: { id: true, isActive: true, status: true },
    });
    // An unknown season goes to its would-be page, which shows the site's
    // own not-found screen.
    destination = requested
      ? recapDestination({ requested, active: null, lastArchived: null })
      : `/seasons/${encodeURIComponent(seasonId)}`;
  } else {
    const [active, lastArchived] = await Promise.all([
      getActiveSeason(),
      prisma.season.findFirst({
        where: { isActive: false },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
      }),
    ]);
    destination = recapDestination({ requested: null, active, lastArchived });
  }
  return NextResponse.redirect(new URL(destination, request.url));
}
