-- The match-night poll: a ranked-choice vote on the weekly match slot. Two
-- new tables only; nothing existing changes, so the binary already serving
-- never reads or writes them.

BEGIN;

-- CreateTable
CREATE TABLE "MatchNightPoll" (
    "id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "slots" TEXT NOT NULL,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastBallotAt" TIMESTAMP(3),

    CONSTRAINT "MatchNightPoll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchNightBallot" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ranking" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchNightBallot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MatchNightPoll_closesAt_idx" ON "MatchNightPoll"("closesAt");

-- CreateIndex
CREATE INDEX "MatchNightBallot_userId_idx" ON "MatchNightBallot"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchNightBallot_pollId_userId_key" ON "MatchNightBallot"("pollId", "userId");

-- AddForeignKey
ALTER TABLE "MatchNightPoll" ADD CONSTRAINT "MatchNightPoll_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchNightBallot" ADD CONSTRAINT "MatchNightBallot_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "MatchNightPoll"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchNightBallot" ADD CONSTRAINT "MatchNightBallot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


COMMIT;
