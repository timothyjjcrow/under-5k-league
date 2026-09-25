import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { readAcceptedBids } from "@/lib/draft-history";
import { Badge, Card, CardBody, CardHeader, textLink } from "./ui";

function nomineeName(raw: string) {
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && "name" in value && typeof value.name === "string") return value.name;
  } catch { /* Keep the receipt visible even if its old label is unavailable. */ }
  return "Name not recorded";
}

/** Public auction facts only. Opening pool snapshots and audit actor ids stay
 * on the server. Aborted/undone receipts remain visible but never enter totals. */
export async function AuctionHistory({ seasonId }: { seasonId: string }) {
  const [count, lots] = await Promise.all([
    prisma.draftLot.count({ where: { run: { seasonId } } }),
    prisma.draftLot.findMany({
      where: { run: { seasonId } }, orderBy: [{ recordedAt: "desc" }, { id: "desc" }], take: 200,
      select: {
        id: true, sequence: true, provenance: true, nomineeSnapshot: true, nominatedUserId: true,
        status: true, soldTeamId: true, soldTeamNameSnapshot: true, soldPrice: true,
        acceptedBidsSnapshot: true, closeReason: true, reversalReason: true,
        run: { select: { runNumber: true, status: true, provenance: true } },
      },
    }),
  ]);
  if (!count) return null;
  return <Card>
    <CardHeader title="Auction history" subtitle="Original auction receipts survive roster moves, undone picks, and restarts." />
    <CardBody>
      <details>
        <summary className="cursor-pointer py-2 text-sm font-semibold">View {count > lots.length ? `latest ${lots.length} of ${count}` : count} recorded nominations</summary>
        <div className="mt-3 divide-y divide-line/60">
          {lots.map((lot) => {
            let bids: ReturnType<typeof readAcceptedBids> | null = null;
            try { bids = readAcceptedBids(lot.acceptedBidsSnapshot); } catch { /* Display an explicit unavailable state. */ }
            const name = nomineeName(lot.nomineeSnapshot);
            return <div key={lot.id} className="space-y-2 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">{lot.run.provenance === "COMMAND" ? "Run" : "Captured run"} {lot.run.runNumber}{lot.sequence != null ? ` · ${lot.run.provenance === "COMMAND" ? "Nomination" : "Recorded nomination"} ${lot.sequence}` : " · Legacy observation"}</span>
                {lot.nominatedUserId ? <Link className={textLink()} href={`/players/${lot.nominatedUserId}`}>{name}</Link> : <strong>{name}</strong>}
                <Badge>{lot.status.toLowerCase()}</Badge>
                {lot.run.status === "ABORTED" ? <Badge>Aborted run</Badge> : null}
                {lot.soldPrice != null ? <span>${lot.soldPrice} · {lot.soldTeamId ? <Link className={textLink()} href={`/teams/${lot.soldTeamId}`}>{lot.soldTeamNameSnapshot ?? "Former team"}</Link> : lot.soldTeamNameSnapshot ?? "Former team"}</span> : null}
              </div>
              {lot.reversalReason || lot.closeReason ? <p className="text-xs text-muted">{(lot.reversalReason ?? lot.closeReason)?.replaceAll("_", " ").toLowerCase()}</p> : null}
              {lot.provenance !== "COMMAND" ? <p className="text-xs text-muted">Captured from surviving records; earlier bidding and nomination boundaries are unknown.</p> : null}
              {lot.run.provenance !== "COMMAND" && lot.provenance === "COMMAND" ? <p className="text-xs text-muted">This nomination was recorded after history capture began; earlier draft order is unknown.</p> : null}
              {bids && bids.bids.length > 0 ? <details className="text-xs text-muted">
                <summary className="cursor-pointer py-1">{bids.bids.length} {bids.provenance === "COMMAND" ? "accepted bids" : "surviving bids (may span earlier nominations)"}</summary>
                <ol className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                  {bids.bids.map((bid) => <li key={bid.bidId}>{bid.teamName}: ${bid.amount}</li>)}
                </ol>
              </details> : !bids ? <p className="text-xs text-muted">Bid receipt unavailable.</p> : null}
            </div>;
          })}
        </div>
      </details>
    </CardBody>
  </Card>;
}
