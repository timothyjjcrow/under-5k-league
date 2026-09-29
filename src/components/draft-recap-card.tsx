import { Card, CardBody, CardHeader, EmojiLead } from "@/components/ui";
import type { DraftRecap } from "@/lib/draft-recap";

/**
 * Draft-night superlatives (biggest spend, best steal, top spender, bargain
 * hunter) from draftRecap. Presentational and server-safe, so the finished
 * draft room (a client component) and /teams share one card instead of two
 * copies that drift. Renders nothing when no player was bought.
 */
export function DraftRecapCard({
  recap,
  title = "Draft night",
  subtitle = `$${recap.totalSpent} spent at the auction`,
}: {
  recap: DraftRecap;
  title?: string;
  subtitle?: string;
}) {
  if (recap.totalSpent <= 0) return null;
  const top = recap.topSpender;
  const bargain = recap.bargainHunter;
  const sameTeam =
    !!top &&
    !!bargain &&
    (bargain.teamId ?? bargain.teamName) === (top.teamId ?? top.teamName);
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      <CardBody className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        {recap.biggestSpend ? (
          <RecapTile
            label="💸 Biggest spend"
            value={`${recap.biggestSpend.name} · $${recap.biggestSpend.price}`}
            detail={recap.biggestSpend.teamName}
          />
        ) : null}
        {recap.bestValue ? (
          <RecapTile
            label="🕵️ Best steal"
            value={`${recap.bestValue.name} · $${recap.bestValue.price}`}
            detail={`${recap.bestValue.mmr} MMR for ${recap.bestValue.teamName}`}
          />
        ) : null}
        {top ? (
          <RecapTile
            label="🐳 Top spender"
            value={top.teamName}
            detail={`$${top.spent} total`}
          />
        ) : null}
        {bargain && !sameTeam ? (
          <RecapTile
            label="🧾 Bargain hunter"
            value={bargain.teamName}
            detail={`$${bargain.spent} total`}
          />
        ) : null}
      </CardBody>
    </Card>
  );
}

function RecapTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface-2/40 px-4 py-3">
      {/* The leading emoji stays on screen but isn't read out. */}
      <div className="text-xs uppercase tracking-wide text-muted">
        <EmojiLead text={label} />
      </div>
      <div className="mt-1 truncate font-medium">{value}</div>
      <div className="truncate text-xs text-muted">{detail}</div>
    </div>
  );
}
