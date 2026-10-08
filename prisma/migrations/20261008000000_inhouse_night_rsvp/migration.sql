-- The inhouse night's "I'm in": one row per player for the planned night,
-- which is a Setting row, so nightId is its id rather than a foreign key. One
-- new table only; nothing existing changes, so the binary already serving
-- never reads or writes it.

BEGIN;

-- CreateTable
CREATE TABLE "InhouseNightRsvp" (
    "nightId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InhouseNightRsvp_pkey" PRIMARY KEY ("nightId","userId")
);

-- CreateIndex
CREATE INDEX "InhouseNightRsvp_userId_idx" ON "InhouseNightRsvp"("userId");

-- AddForeignKey
ALTER TABLE "InhouseNightRsvp" ADD CONSTRAINT "InhouseNightRsvp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
