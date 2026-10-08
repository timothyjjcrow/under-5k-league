import { NextResponse, type NextRequest } from "next/server";
import { heroSearchDestination } from "@/lib/heroes";
import { singleSearchParam } from "@/lib/search-params";

// The hero search's form target when scripts haven't run (HeroSearch): GET
// /meta/find?q=jugg[&season=<id>] redirects to the best match's hero page, or
// back to Hero meta when nothing matches. A real HTTP redirect, like /recap.
// It reads nothing and writes nothing, so loading it as an image is harmless.
export function GET(request: NextRequest) {
  const read = (key: string) => {
    const values = request.nextUrl.searchParams.getAll(key);
    // A repeated key is unavailable, never an array (singleSearchParam).
    return singleSearchParam(values.length > 1 ? values : values[0]) ?? undefined;
  };
  return NextResponse.redirect(
    new URL(heroSearchDestination(read("q") ?? "", read("season")), request.url),
  );
}
