import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { gameQualityReasons } from "@/lib/admin-attention";
import { singleSearchParam } from "@/lib/search-params";
import {
  Card,
  CardBody,
  PageTitle,
  buttonClasses,
  textLink,
} from "@/components/ui";

export const metadata = { title: "Imported-game quality" };

export default async function DataQualityPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string | string[] }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/admin/data-quality");
  if (user.role !== "ADMIN") notFound();
  const seasonId = singleSearchParam((await searchParams).season);
  if (seasonId === null) notFound();
  const season = seasonId
    ? await prisma.season.findUnique({
        where: { id: seasonId },
        select: { id: true, name: true },
      })
    : null;
  if (seasonId && !season) notFound();
  // The large JSON read happens only on this diagnostic route, never on the
  // match-night console. No mutation/retry is performed by visiting it.
  const games = await prisma.game.findMany({
    where: seasonId ? { match: { seasonId } } : {},
    select: {
      id: true,
      matchId: true,
      dotaMatchId: true,
      players: true,
      match: {
        select: {
          homeTeam: { select: { name: true } },
          awayTeam: { select: { name: true } },
        },
      },
    },
    orderBy: { id: "desc" },
  });
  const issues = games.flatMap((game) => {
    const reasons = gameQualityReasons(game.players);
    return reasons.length ? [{ game, reasons }] : [];
  });
  return (
    <div className="space-y-6">
      <PageTitle
        title="Imported-game quality"
        subtitle={`${season?.name ?? "All seasons"} · ${issues.length} of ${games.length} imported games have items to review.`}
        action={
          <Link href="/admin" className={buttonClasses("secondary", "sm")}>
            Back to admin
          </Link>
        }
      />
      <p className="text-sm text-muted">
        Different reports require different data. These diagnostics identify
        affected games without changing results. Inspect the match before using
        its existing import or attribution controls.
      </p>
      {issues.length ? (
        <ul className="space-y-3">
          {issues.map(({ game, reasons }) => (
            <li key={game.id}>
              <Card>
                <CardBody className="space-y-2 text-sm">
                  <Link
                    href={`/matches/${game.matchId}`}
                    className={textLink()}
                  >
                    {game.match.homeTeam?.name ?? "TBD"} vs{" "}
                    {game.match.awayTeam?.name ?? "TBD"} · Dota game{" "}
                    {game.dotaMatchId}
                  </Link>
                  <ul className="list-disc space-y-1 pl-5 text-muted">
                    {reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">
          No box-score quality issues found in this scope.
        </p>
      )}
    </div>
  );
}
