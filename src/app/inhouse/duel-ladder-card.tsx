import {
  Avatar,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PlayerLink,
} from "@/components/ui";
import { loadDuelLadder } from "@/lib/inhouse-duel-service";
import { PROVISIONAL_GAMES } from "@/lib/inhouse-stats";
import { cn } from "@/lib/utils";

const count = new Intl.NumberFormat("en-US");

/**
 * The 1v1 mid leaderboard (docs/features/inhouse-duels.md): its own Elo,
 * derived from every completed 1v1 (loadDuelLadder, memoized on the latest
 * result), never the 5v5 ladder's. Ranked players first, provisional ones
 * (under PROVISIONAL_GAMES 1v1s) after them, unranked. Streamed in its own
 * Suspense on /inhouse, after the 5v5 ladder.
 */
export async function DuelLadderCard({ meId }: { meId: string | null }) {
  const { ranked, provisional } = await loadDuelLadder();
  const rows = [...ranked, ...provisional];
  return (
    // overflow-hidden on the CARD: the table scroller inside must not leak
    // its width into the page (CLAUDE.md mobile rule).
    <Card className="overflow-hidden">
      <CardHeader
        headingLevel={2}
        title="1v1 mid leaderboard"
        subtitle={
          rows.length > 0
            ? `${count.format(rows.length)} players · ${count.format(ranked.length)} ranked · its own Elo, apart from the 5v5 ladder`
            : "Its own Elo, apart from the 5v5 ladder"
        }
      />
      <CardBody className="p-0">
        {rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              inline
              title="No 1v1s recorded yet."
              description="Win one to top this board."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full table-fixed text-sm">
              <caption className="sr-only">
                1v1 mid ratings and records. Provisional players are listed
                without a rank.
              </caption>
              <colgroup>
                <col className="w-11" />
                <col />
                <col className="w-[4.5rem]" />
                <col className="w-10" />
                <col className="w-10" />
              </colgroup>
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase text-muted">
                  <th className="px-4 py-2.5 font-medium sm:px-5">#</th>
                  <th className="px-2 py-2.5 font-medium">Player</th>
                  <th className="px-2 py-2.5 text-right font-medium">Rating</th>
                  <th className="px-2 py-2.5 text-center font-medium">W</th>
                  <th className="px-2 py-2.5 text-center font-medium">L</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const isRanked = i < ranked.length;
                  return (
                    <tr
                      key={r.userId}
                      className={cn(
                        "border-b border-line/50 last:border-0",
                        r.userId === meId ? "bg-accent/5" : "",
                      )}
                    >
                      <td className="px-4 py-2.5 text-muted tabular-nums sm:px-5">
                        {isRanked ? (
                          i + 1
                        ) : (
                          <span
                            title={`Provisional — under ${PROVISIONAL_GAMES} 1v1s, not ranked yet`}
                            aria-label="Unranked (provisional)"
                          >
                            —
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2.5">
                        <span className="flex min-w-0 items-center gap-2">
                          <Avatar name={r.name} src={r.avatar} size={24} />
                          <PlayerLink
                            userId={r.userId}
                            className="min-w-6 truncate font-medium"
                          >
                            {r.name}
                          </PlayerLink>
                        </span>
                      </td>
                      <td
                        className={cn(
                          "whitespace-nowrap px-2 py-2.5 text-right font-semibold tabular-nums",
                          isRanked ? "" : "text-muted",
                        )}
                      >
                        {count.format(r.rating)}
                      </td>
                      <td className="px-2 py-2.5 text-center text-success tabular-nums">
                        {count.format(r.wins)}
                      </td>
                      <td className="px-2 py-2.5 text-center text-muted tabular-nums">
                        {count.format(r.losses)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-line px-4 py-2 text-xs text-muted sm:px-5">
          Everyone starts at 1,000. A rank shows after {PROVISIONAL_GAMES} 1v1s.
        </p>
      </CardBody>
    </Card>
  );
}
