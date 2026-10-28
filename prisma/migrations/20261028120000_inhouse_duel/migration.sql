-- The 1v1 mid inhouse ("duel"): two new tables, its queue and its games.
-- Nothing else changes. The binary already serving never reads or writes
-- either, so a duel is simply absent to it. No backfill.

BEGIN;

-- CreateTable
CREATE TABLE "InhouseDuelQueueEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InhouseDuelQueueEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InhouseDuel" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "radiantUserId" TEXT NOT NULL,
    "direUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3),
    "botMatchId" TEXT,
    "dotaMatchId" TEXT,
    "winnerTeam" INTEGER,
    "durationSecs" INTEGER,
    "radiantHeroId" INTEGER,
    "direHeroId" INTEGER,
    "matchStartTime" TIMESTAMP(3),
    "endReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InhouseDuel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InhouseDuelQueueEntry_userId_key" ON "InhouseDuelQueueEntry"("userId");

-- CreateIndex
CREATE INDEX "InhouseDuelQueueEntry_joinedAt_idx" ON "InhouseDuelQueueEntry"("joinedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InhouseDuel_dotaMatchId_key" ON "InhouseDuel"("dotaMatchId");

-- CreateIndex
CREATE INDEX "InhouseDuel_status_createdAt_idx" ON "InhouseDuel"("status", "createdAt");

-- CreateIndex
CREATE INDEX "InhouseDuel_status_completedAt_idx" ON "InhouseDuel"("status", "completedAt");

-- CreateIndex
CREATE INDEX "InhouseDuel_radiantUserId_idx" ON "InhouseDuel"("radiantUserId");

-- CreateIndex
CREATE INDEX "InhouseDuel_direUserId_idx" ON "InhouseDuel"("direUserId");

-- AddForeignKey
ALTER TABLE "InhouseDuelQueueEntry" ADD CONSTRAINT "InhouseDuelQueueEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InhouseDuel" ADD CONSTRAINT "InhouseDuel_radiantUserId_fkey" FOREIGN KEY ("radiantUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InhouseDuel" ADD CONSTRAINT "InhouseDuel_direUserId_fkey" FOREIGN KEY ("direUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
