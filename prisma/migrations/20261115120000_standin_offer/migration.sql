-- Standin offers: a standin's "I can play" for one side of one match, which
-- the captain's Standins card lists first. One new table only; nothing
-- existing changes, so the binary already serving never reads or writes it.
-- No backfill.

BEGIN;

-- CreateTable
CREATE TABLE "StandinOffer" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StandinOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StandinOffer_userId_idx" ON "StandinOffer"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "StandinOffer_matchId_teamId_userId_key" ON "StandinOffer"("matchId", "teamId", "userId");

-- AddForeignKey
ALTER TABLE "StandinOffer" ADD CONSTRAINT "StandinOffer_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StandinOffer" ADD CONSTRAINT "StandinOffer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
