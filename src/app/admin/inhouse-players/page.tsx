import Link from "@/components/app-link";
import { notFound, redirect } from "next/navigation";
import { AdminInhouseRatingEditor } from "@/components/admin-inhouse-rating-editor";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  PageTitle,
  PlayerLink,
  RankMedal,
  buttonClasses,
} from "@/components/ui";
import { getSessionUser } from "@/lib/auth";
import { inhouseMmrStanding, overInhouseCap } from "@/lib/inhouse-rating";
import {
  loadInhouseRatingPage,
  type InhouseRatingRow,
} from "@/lib/inhouse-rating-service";
import { rankMedalTier } from "@/lib/rank";
import { singleSearchParam } from "@/lib/search-params";

export const metadata = { title: "Inhouse players" };

/** A fixed locale, so the server and every reader print "4,350". */
const MMR_FORMAT = new Intl.NumberFormat("en-US");

/**
 * An admin's inhouse MMR and medal for any player, signed up for the league
 * or not (Tim, 2026-10-17). Every inhouse join uses the MMR set here, over a
 * league signup's and anything typed; the medal is the site-wide one. Find a
 * player by name, Steam ID or profile link, or pick one from the queue or
 * the latest games.
 */
export default async function InhousePlayersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/admin/inhouse-players");
  if (user.role !== "ADMIN") notFound();
  const raw = singleSearchParam((await searchParams).q);
  if (raw === null) notFound();
  const search = raw ? raw.slice(0, 100) : null;
  const page = await loadInhouseRatingPage(search);
  const input =
    "min-h-11 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm";

  return (
    <div className="space-y-6">
      <PageTitle
        title="Inhouse players"
        subtitle="Set any player's inhouse MMR and medal, signed up for the league or not. Every inhouse join uses the MMR set here, over their league signup's and anything they type."
        action={
          <>
            <Link href="/inhouse" className={buttonClasses("secondary", "sm")}>
              Inhouse room
            </Link>
            <Link href="/admin" className={buttonClasses("secondary", "sm")}>
              Back to admin
            </Link>
          </>
        }
      />
      <Card>
        <CardBody>
          <form method="get" role="search" className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1 basis-56 space-y-1 text-sm">
              <span>Find a player</span>
              <input
                name="q"
                type="search"
                defaultValue={search ?? ""}
                maxLength={100}
                placeholder="Name, Steam ID or link"
                className={input}
              />
            </label>
            <button type="submit" className={buttonClasses("primary", "md")}>
              Search
            </button>
            {search ? (
              <Link href="/admin/inhouse-players" className={buttonClasses("ghost", "md")}>
                Clear
              </Link>
            ) : null}
          </form>
        </CardBody>
      </Card>
      {page.results !== null ? (
        <PlayerList
          title="Search results"
          subtitle={`Players matching “${search}”.`}
          rows={page.results}
          empty="Nobody matches. Try part of their name, their Steam ID, or a Steam, OpenDota or Dotabuff link."
        />
      ) : (
        <>
          <PlayerList
            title="In the queue"
            subtitle="In queue order. A saved MMR goes onto their queue spot at once."
            rows={page.queued}
            empty="Nobody is queued."
          />
          <PlayerList
            title="Recent inhouse players"
            subtitle="Everyone from the latest games, newest first."
            rows={page.recent}
            empty="No inhouse games yet."
          />
          {page.adminSet.length > 0 ? (
            <PlayerList
              title="Other players with an admin's MMR or medal"
              rows={page.adminSet}
              empty=""
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function PlayerList({
  title,
  subtitle,
  rows,
  empty,
}: {
  title: string;
  subtitle?: string;
  rows: InhouseRatingRow[];
  empty: string;
}) {
  return (
    <Card>
      <CardHeader headingLevel={2} title={title} subtitle={subtitle} />
      <CardBody>
        {rows.length === 0 ? (
          <p className="text-sm text-muted">{empty}</p>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((row) => (
              <PlayerRow key={row.id} row={row} />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function PlayerRow({ row }: { row: InhouseRatingRow }) {
  const standing = inhouseMmrStanding(row);
  return (
    <li className="min-w-0 py-3 first:pt-0 last:pb-0" data-inhouse-player={row.id}>
      <div className="flex min-w-0 items-start gap-3">
        <Avatar name={row.name} src={row.avatar} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <PlayerLink userId={row.id} className="min-w-6 max-w-full truncate font-medium">
              {row.name}
            </PlayerLink>
            {rankMedalTier(row.rankTier) > 0 ? (
              <RankMedal rankTier={row.rankTier} size={20} showLabel />
            ) : (
              <span className="text-xs text-muted">No medal</span>
            )}
            {row.rankTierManual ? <Badge tone="info">manual medal</Badge> : null}
            {overInhouseCap({ mmr: standing.mmr, rankTier: row.rankTier }) ? (
              <Badge tone="danger">over the inhouse cap</Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {standing.mmr !== null ? (
              <>
                <span className="tabular-nums text-fg">
                  {MMR_FORMAT.format(standing.mmr)}
                </span>
                {` MMR, ${standing.source}`}
              </>
            ) : (
              `MMR ${standing.source}`
            )}
            {row.queuedMmr === null
              ? null
              : row.queuedMmr > 0
                ? ` · queued at ${MMR_FORMAT.format(row.queuedMmr)}`
                : " · queued with no MMR"}
          </p>
          <AdminInhouseRatingEditor
            key={`${row.id}:${row.adminMmr}:${row.rankTier}:${row.rankTierManual}`}
            userId={row.id}
            name={row.name}
            adminMmr={row.adminMmr}
            rankTier={row.rankTier}
            rankTierManual={row.rankTierManual}
          />
        </div>
      </div>
    </li>
  );
}
