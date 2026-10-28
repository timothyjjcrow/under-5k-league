-- The 1v1 accept step: when each side of a new 1v1 accepted. Two nullable
-- columns, nothing else. The binary already serving never reads or writes
-- them, and never makes an ACCEPTING duel. No backfill.

BEGIN;

-- AlterTable
ALTER TABLE "InhouseDuel" ADD COLUMN "radiantAcceptedAt" TIMESTAMP(3),
ADD COLUMN "direAcceptedAt" TIMESTAMP(3);

COMMIT;
