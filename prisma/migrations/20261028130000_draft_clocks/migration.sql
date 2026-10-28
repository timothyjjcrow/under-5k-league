-- The draft auction's three clocks, set per season with the draft settings
-- before Start. Each column's default is the clock every season has run so
-- far (30s a bid, 5s for a lot nobody can top, 90s to nominate), so existing
-- seasons keep their clocks, and the binary already serving never reads the
-- columns. No backfill.

BEGIN;

-- AlterTable
ALTER TABLE "Season" ADD COLUMN "draftBidSeconds" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN "draftNominationSeconds" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN "draftUncontestedBidSeconds" INTEGER NOT NULL DEFAULT 5;

COMMIT;
