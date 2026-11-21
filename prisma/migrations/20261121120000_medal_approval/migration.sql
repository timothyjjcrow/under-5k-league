-- Medal approvals: a player over the league's medal line asking an admin to
-- let them in, and the admin's answer with the MMR they play at. One new
-- table only; nothing existing changes, so the binary already serving never
-- reads or writes it. No backfill.

BEGIN;

-- CreateTable
CREATE TABLE "MedalApproval" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "rankTier" INTEGER,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mmr" INTEGER,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decidedByName" TEXT,

    CONSTRAINT "MedalApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MedalApproval_userId_key" ON "MedalApproval"("userId");

-- CreateIndex
CREATE INDEX "MedalApproval_status_requestedAt_idx" ON "MedalApproval"("status", "requestedAt");

-- AddForeignKey
ALTER TABLE "MedalApproval" ADD CONSTRAINT "MedalApproval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
