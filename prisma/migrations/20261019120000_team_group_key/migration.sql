-- Each team's group in a season played in two groups (10 or more teams).
-- Nullable with no default: null is a one-table season, which is every
-- season the binary already serving knows (it never reads or writes the
-- column), so this changes nothing it relies on. No backfill.

BEGIN;

-- AlterTable
ALTER TABLE "Team" ADD COLUMN "groupKey" TEXT;

COMMIT;
