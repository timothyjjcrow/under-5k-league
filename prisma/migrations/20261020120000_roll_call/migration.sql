-- The season's roll call: Home's "I'm in" for the match night. One nullable
-- column on Season (when an admin opened it; null = closed) and one new
-- table of answers. The binary already serving never reads or writes
-- either, and a null column is a closed roll call, so nothing it relies on
-- changes. No backfill.

BEGIN;

-- AlterTable
ALTER TABLE "Season" ADD COLUMN "rollCallOpenedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RollCallAnswer" (
    "seasonId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "matchNight" TEXT NOT NULL,
    "answeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RollCallAnswer_pkey" PRIMARY KEY ("seasonId","userId")
);

-- CreateIndex
CREATE INDEX "RollCallAnswer_userId_idx" ON "RollCallAnswer"("userId");

-- AddForeignKey
ALTER TABLE "RollCallAnswer" ADD CONSTRAINT "RollCallAnswer_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RollCallAnswer" ADD CONSTRAINT "RollCallAnswer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
