-- A standin more than 100 MMR above the seat waits for the other captain to
-- agree. One new table of those requests; nothing else changes. The binary
-- already serving never reads or writes it, so a request is simply absent to
-- it. No backfill.

BEGIN;

-- CreateTable
CREATE TABLE "StandinRequest" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "standinUserId" TEXT NOT NULL,
    "replacingUserId" TEXT,
    "requestedById" TEXT NOT NULL,
    "standinMmr" INTEGER NOT NULL,
    "baselineMmr" INTEGER,
    "baselineUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,

    CONSTRAINT "StandinRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StandinRequest_matchId_status_idx" ON "StandinRequest"("matchId", "status");

-- AddForeignKey
ALTER TABLE "StandinRequest" ADD CONSTRAINT "StandinRequest_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StandinRequest" ADD CONSTRAINT "StandinRequest_standinUserId_fkey" FOREIGN KEY ("standinUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StandinRequest" ADD CONSTRAINT "StandinRequest_replacingUserId_fkey" FOREIGN KEY ("replacingUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StandinRequest" ADD CONSTRAINT "StandinRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StandinRequest" ADD CONSTRAINT "StandinRequest_baselineUserId_fkey" FOREIGN KEY ("baselineUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
