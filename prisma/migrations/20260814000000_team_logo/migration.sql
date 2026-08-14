-- Team artwork is optional so the existing deterministic monogram remains a
-- rollback-safe fallback for every current and historical team.

BEGIN;

ALTER TABLE "Team" ADD COLUMN "logoUrl" TEXT;

COMMIT;
