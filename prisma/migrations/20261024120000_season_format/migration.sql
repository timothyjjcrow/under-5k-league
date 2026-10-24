-- The season format an admin chose (the season builder): versioned JSON,
-- {"v":1,"groups":2,"meet":1,"playoffs":4}. Nullable with no default: null
-- is the Recommended format, the team-count rule every season already
-- plays, and the binary already serving never reads or writes the column,
-- so this changes nothing it relies on. No backfill.

BEGIN;

-- AlterTable
ALTER TABLE "Season" ADD COLUMN "formatConfig" TEXT;

COMMIT;
