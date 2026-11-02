import { Avatar, Card, CardBody, CardHeader, PlayerLink } from "@/components/ui";
import { LocalTime } from "@/components/local-time";
import { activeInhouseBans, INHOUSE_BANS_ANCHOR } from "@/lib/inhouse-ban";
import { loadActiveInhouseBanRows } from "@/lib/inhouse-ban-service";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { prisma } from "@/lib/prisma";

/**
 * The inhouse bans running now, with their reasons (Tim, 2026-11-02): who
 * can't queue, until when (the viewer's clock) and why. The same list as the
 * Discord queue board's. Nothing renders while nobody is banned. Streamed in
 * its own Suspense on /inhouse, under the room and the plans, so it never
 * holds up or pushes down the queue.
 */
export async function InhouseBansCard() {
  // eslint-disable-next-line react-hooks/purity -- async server component
  const nowMs = Date.now();
  const bans = activeInhouseBans(await loadActiveInhouseBanRows(prisma, nowMs), nowMs);
  if (bans.length === 0) return null;
  return (
    <section
      id={INHOUSE_BANS_ANCHOR}
      className="scroll-mt-28"
      aria-label="Banned from inhouse"
    >
      <Card>
        <CardHeader
          headingLevel={2}
          title="Banned from inhouse"
          subtitle="These players can't join the 5v5 or the 1v1 queue until their ban ends."
        />
        <CardBody>
          <ul className="divide-y divide-line">
            {bans.map((ban) => (
              <li key={ban.id} className="min-w-0 py-3 first:pt-0 last:pb-0">
                <div className="flex min-w-0 items-start gap-3">
                  <Avatar name={ban.name} src={ban.avatar} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <PlayerLink
                        userId={ban.userId}
                        className="min-w-6 max-w-full truncate font-medium"
                      >
                        {ban.name}
                      </PlayerLink>
                      <span className="text-xs text-muted">
                        {ban.endsAtMs === null ? (
                          "Permanent"
                        ) : (
                          <>
                            {"Until "}
                            <LocalTime
                              ts={ban.endsAtMs}
                              variant="full"
                              initial={formatLeagueMatchTime(new Date(ban.endsAtMs), "full")}
                            />
                          </>
                        )}
                      </span>
                    </div>
                    <p className="mt-0.5 text-sm break-words">{ban.reason}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </section>
  );
}
