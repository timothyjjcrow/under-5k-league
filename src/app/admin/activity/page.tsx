import { formatMatchTime } from "@/lib/match-time";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { adminHistoryWhere } from "@/lib/admin-history-filters";
import { singleSearchParam } from "@/lib/search-params";
import { LocalTime } from "@/components/local-time";
import {
  Card,
  CardBody,
  PageTitle,
  buttonClasses,
  textLink,
} from "@/components/ui";

export const metadata = { title: "Admin activity" };
type Query = {
  season?: string | string[];
  action?: string | string[];
  actor?: string | string[];
  from?: string | string[];
  to?: string | string[];
  before?: string | string[];
};

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Query>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/admin/activity");
  if (user.role !== "ADMIN") notFound();
  const query = await searchParams;
  const filters = Object.fromEntries(
    Object.entries(query).map(([key, value]) => [
      key,
      singleSearchParam(value) ?? "",
    ]),
  ) as Record<keyof Query, string>;
  const where = adminHistoryWhere(filters);
  // Compare both stable sort keys; missing/deleted cursors must never silently
  // move the reader to an unrelated page.
  const cursor = filters.before
    ? await prisma.adminAction.findUnique({
        where: { id: filters.before },
        select: { id: true, createdAt: true },
      })
    : null;
  if (filters.before && !cursor) notFound();
  const [results, seasons] = await Promise.all([
    prisma.adminAction.findMany({
      where: {
        ...where,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 41,
    }),
    prisma.season.findMany({
      select: { id: true, name: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const rows = results.slice(0, 40);
  const next = new URLSearchParams(
    Object.entries(filters).filter(
      ([key, value]) => key !== "before" && !!value,
    ),
  );
  if (rows.length) next.set("before", rows[rows.length - 1].id);
  const names = new Map(seasons.map((season) => [season.id, season.name]));
  const input =
    "min-h-11 w-full rounded-lg border border-line bg-surface-2 px-3";
  return (
    <div className="space-y-6">
      <PageTitle
        title="Admin activity"
        subtitle="Search recorded actions. Dates use UTC; logging is best-effort and may not capture every change."
        action={
          <Link
            href="/admin#adm-activity"
            className={buttonClasses("secondary", "sm")}
          >
            Back to admin
          </Link>
        }
      />
      <Card>
        <CardBody>
          <form className="grid gap-3 text-sm sm:grid-cols-3" method="get">
            <label className="space-y-1">
              <span>Season</span>
              <select
                name="season"
                defaultValue={filters.season ?? ""}
                className={input}
              >
                <option value="">All seasons</option>
                <option value="global">Season-independent</option>
                {seasons.map((season) => (
                  <option key={season.id} value={season.id}>
                    {season.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span>Action contains</span>
              <input
                name="action"
                defaultValue={filters.action}
                maxLength={100}
                className={input}
              />
            </label>
            <label className="space-y-1">
              <span>Actor name contains</span>
              <input
                name="actor"
                defaultValue={filters.actor}
                maxLength={100}
                className={input}
              />
            </label>
            <label className="space-y-1">
              <span>From (UTC)</span>
              <input
                name="from"
                type="date"
                defaultValue={filters.from}
                className={input}
              />
            </label>
            <label className="space-y-1">
              <span>Through (UTC)</span>
              <input
                name="to"
                type="date"
                defaultValue={filters.to}
                className={input}
              />
            </label>
            <div className="flex items-end gap-3">
              <button className={buttonClasses("primary")} type="submit">
                Filter activity
              </button>
              <Link href="/admin/activity" className={textLink()}>
                Reset
              </Link>
            </div>
          </form>
        </CardBody>
      </Card>
      <p className="text-xs text-muted">
        Text matching follows the database&apos;s case rules. Use the spelling
        shown in the recorded entry.
      </p>
      {rows.length ? (
        <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.id}>
              <Card>
                <CardBody className="space-y-1 text-sm">
                  <p className="font-medium">
                    {row.actorName} ·{" "}
                    <span className="break-all">{row.action}</span>
                  </p>
                  <p>{row.summary}</p>
                  <p className="text-xs text-muted">
                    <LocalTime
                      ts={row.createdAt.getTime()}
                      variant="full"
                      initial={formatMatchTime(row.createdAt, "full")}
                    />{" "}
                    ·{" "}
                    {row.seasonId ? (
                      names.has(row.seasonId) ? (
                        <Link
                          href={`/seasons/${row.seasonId}`}
                          className={textLink()}
                        >
                          {names.get(row.seasonId)}
                        </Link>
                      ) : (
                        "Former season"
                      )
                    ) : (
                      "Season-independent"
                    )}
                  </p>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">No recorded actions match these filters.</p>
      )}
      <nav aria-label="Activity pages" className="flex gap-4">
        {filters.before ? (
          <Link
            href={`/admin/activity?${new URLSearchParams(Object.entries(filters).filter(([key, value]) => key !== "before" && !!value))}`}
            className={buttonClasses("secondary")}
          >
            Newest matching actions
          </Link>
        ) : null}
        {results.length > 40 ? (
          <Link
            href={`/admin/activity?${next}`}
            className={buttonClasses("secondary")}
          >
            Older actions →
          </Link>
        ) : null}
      </nav>
    </div>
  );
}
