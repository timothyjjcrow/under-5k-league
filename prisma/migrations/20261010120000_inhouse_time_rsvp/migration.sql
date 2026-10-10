-- Play later: a player's "I'm in" for an inhouse time posted on /inhouse. A
-- time is just the rows that share a start, so there is no parent table. One
-- new table only; nothing existing changes, so the binary already serving
-- never reads or writes it.

BEGIN;

-- CreateTable
CREATE TABLE "InhouseTimeRsvp" (
    "startsAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InhouseTimeRsvp_pkey" PRIMARY KEY ("startsAt","userId")
);

-- CreateIndex
CREATE INDEX "InhouseTimeRsvp_userId_idx" ON "InhouseTimeRsvp"("userId");

-- AddForeignKey
ALTER TABLE "InhouseTimeRsvp" ADD CONSTRAINT "InhouseTimeRsvp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
