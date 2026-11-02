-- Inhouse bans: an admin's ban on the 5v5 and 1v1 queues, with its reason, its
-- end (null = permanent) and the bot's bookkeeping for the "Inhouse Banned"
-- Discord role. One new table only; nothing existing changes, so the binary
-- already serving never reads or writes it. No backfill.

BEGIN;

-- CreateTable
CREATE TABLE "InhouseBan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "bannedById" TEXT NOT NULL,
    "bannedByName" TEXT NOT NULL,
    "liftedAt" TIMESTAMP(3),
    "liftedByName" TEXT,
    "roleAddedAt" TIMESTAMP(3),
    "roleTriedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "InhouseBan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InhouseBan_userId_liftedAt_idx" ON "InhouseBan"("userId", "liftedAt");

-- CreateIndex
CREATE INDEX "InhouseBan_settledAt_idx" ON "InhouseBan"("settledAt");

-- AddForeignKey
ALTER TABLE "InhouseBan" ADD CONSTRAINT "InhouseBan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
