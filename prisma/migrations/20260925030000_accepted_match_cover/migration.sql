BEGIN;

-- AlterTable
ALTER TABLE "StandinAssignment" ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "acceptedOfferId" TEXT,
ADD COLUMN     "acceptedScheduleRevision" INTEGER,
ADD COLUMN     "consentStatus" TEXT NOT NULL DEFAULT 'LEGACY_UNKNOWN',
ADD COLUMN     "coverRequestId" TEXT;

-- AlterTable
ALTER TABLE "LeagueAnnouncement" ADD COLUMN     "expiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CoverRequest" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "replacingUserId" TEXT,
    "seatKey" TEXT NOT NULL,
    "activeSeatKey" TEXT,
    "position" INTEGER,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "scheduleRevision" INTEGER NOT NULL,
    "scheduledAtSnapshot" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,

    CONSTRAINT "CoverRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoverVolunteer" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "scheduleRevision" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoverVolunteer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoverOffer" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "targetNameSnapshot" TEXT NOT NULL,
    "targetAccountId" DOUBLE PRECISION,
    "kind" TEXT NOT NULL DEFAULT 'INITIAL',
    "status" TEXT NOT NULL DEFAULT 'OFFERED',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "activeRequestKey" TEXT,
    "scheduleRevision" INTEGER NOT NULL,
    "requestRevision" INTEGER NOT NULL,
    "scheduledAtSnapshot" TIMESTAMP(3) NOT NULL,
    "offeredById" TEXT NOT NULL,
    "offeredByName" TEXT NOT NULL,
    "offeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "assignmentId" TEXT,
    "offerDecisionId" TEXT,
    "acceptanceDecisionId" TEXT,

    CONSTRAINT "CoverOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoverEligibilityDecision" (
    "id" TEXT NOT NULL,
    "commandKey" TEXT NOT NULL,
    "commandFingerprint" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "offerId" TEXT,
    "candidateUserId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "scheduleRevision" INTEGER NOT NULL,
    "requestRevision" INTEGER NOT NULL,
    "factsFingerprint" TEXT NOT NULL,
    "factsJson" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoverEligibilityDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CoverRequest_activeSeatKey_key" ON "CoverRequest"("activeSeatKey");

-- CreateIndex
CREATE INDEX "CoverRequest_matchId_status_idx" ON "CoverRequest"("matchId", "status");

-- CreateIndex
CREATE INDEX "CoverRequest_status_scheduledAtSnapshot_idx" ON "CoverRequest"("status", "scheduledAtSnapshot");

-- CreateIndex
CREATE INDEX "CoverVolunteer_userId_status_idx" ON "CoverVolunteer"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CoverVolunteer_requestId_userId_key" ON "CoverVolunteer"("requestId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "CoverOffer_activeRequestKey_key" ON "CoverOffer"("activeRequestKey");

-- CreateIndex
CREATE INDEX "CoverOffer_targetUserId_status_expiresAt_idx" ON "CoverOffer"("targetUserId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "CoverOffer_status_expiresAt_idx" ON "CoverOffer"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "CoverOffer_requestId_acceptedAt_idx" ON "CoverOffer"("requestId", "acceptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CoverEligibilityDecision_commandKey_key" ON "CoverEligibilityDecision"("commandKey");

-- CreateIndex
CREATE INDEX "CoverEligibilityDecision_requestId_createdAt_idx" ON "CoverEligibilityDecision"("requestId", "createdAt");

-- CreateIndex
CREATE INDEX "CoverEligibilityDecision_candidateUserId_createdAt_idx" ON "CoverEligibilityDecision"("candidateUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StandinAssignment_coverRequestId_key" ON "StandinAssignment"("coverRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "StandinAssignment_acceptedOfferId_key" ON "StandinAssignment"("acceptedOfferId");

-- CreateIndex
CREATE INDEX "LeagueAnnouncement_status_expiresAt_idx" ON "LeagueAnnouncement"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "CoverRequest" ADD CONSTRAINT "CoverRequest_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoverVolunteer" ADD CONSTRAINT "CoverVolunteer_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "CoverRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoverOffer" ADD CONSTRAINT "CoverOffer_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "CoverRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoverEligibilityDecision" ADD CONSTRAINT "CoverEligibilityDecision_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "CoverRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
