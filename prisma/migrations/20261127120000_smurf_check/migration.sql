-- The smurf check: a player whose Dota account shows obvious signs of a
-- smurf asks an admin through the same MedalApproval row a medal over the
-- line uses. Two columns with defaults: every existing row is a medal
-- request ('MEDAL', no findings), and the binary already serving never
-- reads or writes them, so its inserts take the defaults. No backfill.

BEGIN;

-- AlterTable
ALTER TABLE "MedalApproval" ADD COLUMN "reason" TEXT NOT NULL DEFAULT 'MEDAL',
ADD COLUMN "signals" TEXT NOT NULL DEFAULT '';

COMMIT;
