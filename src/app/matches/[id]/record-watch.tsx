import Link from "next/link";
import {
  Card,
  CardHeader,
  LinkArrow,
  PlayerLink,
  textLink,
} from "@/components/ui";
import { recordWatchText, type RecordWatchLine } from "@/lib/records";

/**
 * Record watch: tonight's players whose career best sits within reach of a
 * league record (`recordWatchLines`: closest first, at most three). Props
 * only: the page reads the record book in its body and the preview picks the
 * lines for the players on each side's match-night roster, so this card adds
 * no query. Stored marks only, never a pace or an average; nothing renders
 * without a line.
 */
export function RecordWatch({
  lines,
  names,
}: {
  lines: readonly RecordWatchLine[];
  /** Display names by user id, for the players on either side tonight. */
  names: ReadonlyMap<string, string>;
}) {
  if (lines.length === 0) return null;
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Record watch"
        headingLevel={2}
        subtitle="Career bests within reach of a league record"
        action={
          <Link href="/records" className={textLink("text-sm")}>
            Record book <LinkArrow />
          </Link>
        }
      />
      <ul className="divide-y divide-line-soft">
        {lines.map((line) => (
          <li key={line.userId} className="min-w-0 px-4 py-2.5 text-sm">
            <PlayerLink
              userId={line.userId}
              className="max-w-full font-medium [overflow-wrap:anywhere]"
            >
              {names.get(line.userId) ?? "League player"}
            </PlayerLink>
            <p className="text-muted [overflow-wrap:anywhere]">
              <span aria-hidden>{line.emoji} </span>
              {line.title} · {recordWatchText(line)}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
