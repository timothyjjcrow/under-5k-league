-- The reschedule ready check: a proposal can offer up to three times, and
-- everyone playing the match answers each one. Three nullable columns and
-- one new table; nothing existing changes, so the binary already serving keeps
-- reading proposedTime and never touches the votes.

BEGIN;

-- AlterTable
ALTER TABLE "RescheduleRequest" ADD COLUMN "options" TEXT;
ALTER TABLE "RescheduleRequest" ADD COLUMN "note" TEXT;
ALTER TABLE "RescheduleRequest" ADD COLUMN "lockedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RescheduleVote" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "time" TIMESTAMP(3) NOT NULL,
    "ready" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RescheduleVote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RescheduleVote_userId_idx" ON "RescheduleVote"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RescheduleVote_requestId_userId_time_key" ON "RescheduleVote"("requestId", "userId", "time");

-- AddForeignKey
ALTER TABLE "RescheduleVote" ADD CONSTRAINT "RescheduleVote_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "RescheduleRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RescheduleVote" ADD CONSTRAINT "RescheduleVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
