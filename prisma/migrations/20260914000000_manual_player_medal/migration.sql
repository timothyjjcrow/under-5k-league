-- Preserve existing OpenDota medals; only an administrator can opt a player
-- into a manual medal. The effective medal remains in the existing column.

BEGIN;

ALTER TABLE "User" ADD COLUMN "rankTierManual" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
