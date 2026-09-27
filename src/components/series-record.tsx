import {
  seriesRecordSpoken,
  seriesRecordText,
  type SeriesRecordCounts,
} from "@/lib/team-matches";

/**
 * A team's series record as the standings order it, "5W 1D 2L", read aloud
 * as "5 won, 1 drawn, 2 lost". Server-safe.
 */
export function SeriesRecord({ record }: { record: SeriesRecordCounts }) {
  return (
    <>
      <span aria-hidden>{seriesRecordText(record)}</span>
      <span className="sr-only">{seriesRecordSpoken(record)}</span>
    </>
  );
}
