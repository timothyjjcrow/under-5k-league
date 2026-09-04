import type { Prisma } from "@prisma/client";

export function adminHistoryWhere(filters: {
  season?: string;
  action?: string;
  actor?: string;
  from?: string;
  to?: string;
}): Prisma.AdminActionWhereInput {
  const createdAt: Prisma.DateTimeFilter = {};
  const date = (value?: string) => {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
      ? parsed
      : null;
  };
  const from = date(filters.from);
  const to = date(filters.to);
  if (from) createdAt.gte = from;
  if (to) createdAt.lt = new Date(to.getTime() + 86_400_000);
  return {
    ...(filters.season
      ? { seasonId: filters.season === "global" ? null : filters.season }
      : {}),
    ...(filters.action?.trim()
      ? { action: { contains: filters.action.trim().slice(0, 100) } }
      : {}),
    ...(filters.actor?.trim()
      ? { actorName: { contains: filters.actor.trim().slice(0, 100) } }
      : {}),
    ...(from || to ? { createdAt } : {}),
  };
}
