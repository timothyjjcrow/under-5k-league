-- Two nullable columns for the inhouse "Game over" phase and role picks. The
-- binary already serving never reads or writes either one, and never writes
-- the new AWAITING_RESULT status string (a plain string, outside the partial
-- slot index's five live statuses), so this changes nothing it relies on.
-- No backfill: null means "not marked over" and "roles never chosen".

BEGIN;

-- AlterTable
ALTER TABLE "InhouseLobby" ADD COLUMN "finishedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN "inhouseRoles" TEXT;

COMMIT;
