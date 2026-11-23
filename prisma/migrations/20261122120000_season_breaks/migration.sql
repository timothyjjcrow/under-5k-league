-- Breaks: league nights with no games (holidays), as a sorted JSON array of
-- calendar dates on the league's clock, ["2026-12-26"]. Nullable with no
-- default: null is no breaks, which is how every season already plays, and
-- the binary already serving never reads or writes the column, so this
-- changes nothing it relies on. No backfill.

BEGIN;

-- AlterTable
ALTER TABLE "Season" ADD COLUMN "breakDates" TEXT;

COMMIT;
