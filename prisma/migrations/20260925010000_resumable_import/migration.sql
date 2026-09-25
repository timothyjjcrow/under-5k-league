-- Add durable import progress and independent intentional exclusions. Existing
-- games, match scores and legacy suppression settings remain untouched.
BEGIN;

CREATE TABLE "ImportSuppression" (
  "id" TEXT NOT NULL,
  "seasonId" TEXT NOT NULL,
  "dotaMatchId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reason" TEXT NOT NULL DEFAULT 'ADMIN_REMOVAL',
  CONSTRAINT "ImportSuppression_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ImportSuppression_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ImportSuppression_seasonId_dotaMatchId_key" ON "ImportSuppression"("seasonId", "dotaMatchId");

CREATE TABLE "ImportCandidate" (
  "id" TEXT NOT NULL,
  "seasonId" TEXT NOT NULL,
  "dotaMatchId" TEXT NOT NULL,
  "payload" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "reason" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "fetchedAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ImportCandidate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ImportCandidate_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ImportCandidate_seasonId_dotaMatchId_key" ON "ImportCandidate"("seasonId", "dotaMatchId");
CREATE INDEX "ImportCandidate_seasonId_status_nextAttemptAt_idx" ON "ImportCandidate"("seasonId", "status", "nextAttemptAt");
CREATE INDEX "ImportCandidate_expiresAt_idx" ON "ImportCandidate"("expiresAt");

COMMIT;
