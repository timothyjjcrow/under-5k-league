-- Preserve historical membership, auction receipts, confirmed plans and actual appearances.
-- No legacy facts or competitive outcomes are invented by this additive migration.
BEGIN;

-- AlterTable
ALTER TABLE "Draft" ADD COLUMN     "activeRunId" TEXT,
ADD COLUMN     "currentLotId" TEXT;

-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "logisticsRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "scheduleRevision" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "MatchAvailability" ADD COLUMN     "scheduleRevision" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Game" ADD COLUMN     "participantComplete" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "participantSource" TEXT,
ADD COLUMN     "participantVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "AdminAction" ADD COLUMN     "detailsJson" TEXT;

-- CreateTable
CREATE TABLE "RosterTenure" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "teamId" TEXT,
    "userId" TEXT,
    "sourceMembershipId" TEXT NOT NULL,
    "openKey" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startProvenance" TEXT NOT NULL,
    "endProvenance" TEXT,
    "endReason" TEXT,
    "createdById" TEXT,
    "endedById" TEXT,
    "acquisitionKind" TEXT NOT NULL,
    "acquisitionPrice" INTEGER NOT NULL,
    "acquisitionMmr" INTEGER,
    "rolesSnapshot" TEXT,
    "isCaptainAtJoin" BOOLEAN,
    "playerNameSnapshot" TEXT NOT NULL,
    "teamNameSnapshot" TEXT NOT NULL,
    "draftLotId" TEXT,

    CONSTRAINT "RosterTenure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DraftRun" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "runNumber" INTEGER NOT NULL,
    "provenance" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedById" TEXT,
    "rulesSnapshot" TEXT,
    "openingTeamsSnapshot" TEXT,
    "poolSnapshot" TEXT,
    "legacySnapshot" TEXT,
    "nextLotSequence" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "DraftRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DraftLot" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sequence" INTEGER,
    "provenance" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3),
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedById" TEXT,
    "openingKind" TEXT NOT NULL,
    "nominatedUserId" TEXT,
    "nominatorTeamId" TEXT,
    "nomineeSnapshot" TEXT NOT NULL,
    "nominatorSnapshot" TEXT NOT NULL,
    "acceptedBidsSnapshot" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "closedById" TEXT,
    "soldTeamId" TEXT,
    "soldTeamNameSnapshot" TEXT,
    "soldPrice" INTEGER,
    "soldAt" TIMESTAMP(3),
    "sourceMembershipId" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,
    "reversedById" TEXT,

    CONSTRAINT "DraftLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameParticipant" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "sourceLineIndex" INTEGER NOT NULL,
    "userId" TEXT,
    "teamId" TEXT,
    "accountId" DOUBLE PRECISION,
    "heroId" INTEGER NOT NULL,
    "isRadiant" BOOLEAN NOT NULL,
    "kills" INTEGER NOT NULL,
    "deaths" INTEGER NOT NULL,
    "assists" INTEGER NOT NULL,
    "personaname" TEXT,
    "netWorth" DOUBLE PRECISION,
    "gpm" DOUBLE PRECISION,
    "lastHits" DOUBLE PRECISION,
    "xpm" DOUBLE PRECISION,
    "denies" DOUBLE PRECISION,
    "level" DOUBLE PRECISION,
    "heroDamage" DOUBLE PRECISION,
    "towerDamage" DOUBLE PRECISION,
    "heroHealing" DOUBLE PRECISION,
    "benchmarks" TEXT,
    "providerPlayerSlot" INTEGER,
    "plannedPosition" INTEGER,
    "playedPosition" INTEGER,
    "positionSource" TEXT,
    "ratingSnapshot" INTEGER,
    "ratingSource" TEXT,
    "ratingAt" TEXT,

    CONSTRAINT "GameParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchLineup" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "activeKey" TEXT,
    "scheduleRevision" INTEGER NOT NULL,
    "logisticsRevision" INTEGER NOT NULL,
    "scheduledAtSnapshot" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL,
    "confirmedById" TEXT NOT NULL,
    "confirmedByName" TEXT NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "reason" TEXT,
    "compositionFingerprint" TEXT NOT NULL,

    CONSTRAINT "MatchLineup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchLineupSeat" (
    "id" TEXT NOT NULL,
    "lineupId" TEXT NOT NULL,
    "seatKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userNameSnapshot" TEXT NOT NULL,
    "accountId" DOUBLE PRECISION,
    "replacingUserId" TEXT,
    "entryKind" TEXT NOT NULL,
    "acceptanceStatusSnapshot" TEXT NOT NULL,
    "position" INTEGER,
    "mmr" INTEGER,
    "mmrSource" TEXT,
    "ratingAt" TIMESTAMP(3),
    "assignmentId" TEXT,
    "sourceTenureId" TEXT,
    "availabilityAt" TIMESTAMP(3) NOT NULL,
    "eligibilitySnapshot" TEXT,

    CONSTRAINT "MatchLineupSeat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RosterTenure_sourceMembershipId_key" ON "RosterTenure"("sourceMembershipId");

-- CreateIndex
CREATE UNIQUE INDEX "RosterTenure_openKey_key" ON "RosterTenure"("openKey");

-- CreateIndex
CREATE UNIQUE INDEX "RosterTenure_draftLotId_key" ON "RosterTenure"("draftLotId");

-- CreateIndex
CREATE INDEX "RosterTenure_seasonId_userId_joinedAt_idx" ON "RosterTenure"("seasonId", "userId", "joinedAt");

-- CreateIndex
CREATE INDEX "RosterTenure_teamId_joinedAt_idx" ON "RosterTenure"("teamId", "joinedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DraftRun_seasonId_runNumber_key" ON "DraftRun"("seasonId", "runNumber");

-- CreateIndex
CREATE UNIQUE INDEX "DraftLot_sourceMembershipId_key" ON "DraftLot"("sourceMembershipId");

-- CreateIndex
CREATE INDEX "DraftLot_nominatedUserId_idx" ON "DraftLot"("nominatedUserId");

-- CreateIndex
CREATE INDEX "DraftLot_soldTeamId_idx" ON "DraftLot"("soldTeamId");

-- CreateIndex
CREATE UNIQUE INDEX "DraftLot_runId_sequence_key" ON "DraftLot"("runId", "sequence");

-- CreateIndex
CREATE INDEX "GameParticipant_userId_gameId_idx" ON "GameParticipant"("userId", "gameId");

-- CreateIndex
CREATE INDEX "GameParticipant_teamId_gameId_idx" ON "GameParticipant"("teamId", "gameId");

-- CreateIndex
CREATE INDEX "GameParticipant_accountId_gameId_idx" ON "GameParticipant"("accountId", "gameId");

-- CreateIndex
CREATE UNIQUE INDEX "GameParticipant_gameId_sourceLineIndex_key" ON "GameParticipant"("gameId", "sourceLineIndex");

-- CreateIndex
CREATE UNIQUE INDEX "MatchLineup_activeKey_key" ON "MatchLineup"("activeKey");

-- CreateIndex
CREATE INDEX "MatchLineup_teamId_confirmedAt_idx" ON "MatchLineup"("teamId", "confirmedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MatchLineup_matchId_teamId_revision_key" ON "MatchLineup"("matchId", "teamId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "MatchLineupSeat_lineupId_seatKey_key" ON "MatchLineupSeat"("lineupId", "seatKey");

-- CreateIndex
CREATE UNIQUE INDEX "MatchLineupSeat_lineupId_userId_key" ON "MatchLineupSeat"("lineupId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Draft_activeRunId_key" ON "Draft"("activeRunId");

-- CreateIndex
CREATE UNIQUE INDEX "Draft_currentLotId_key" ON "Draft"("currentLotId");

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_activeRunId_fkey" FOREIGN KEY ("activeRunId") REFERENCES "DraftRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_currentLotId_fkey" FOREIGN KEY ("currentLotId") REFERENCES "DraftLot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RosterTenure" ADD CONSTRAINT "RosterTenure_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RosterTenure" ADD CONSTRAINT "RosterTenure_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RosterTenure" ADD CONSTRAINT "RosterTenure_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RosterTenure" ADD CONSTRAINT "RosterTenure_draftLotId_fkey" FOREIGN KEY ("draftLotId") REFERENCES "DraftLot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftRun" ADD CONSTRAINT "DraftRun_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftLot" ADD CONSTRAINT "DraftLot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DraftRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftLot" ADD CONSTRAINT "DraftLot_nominatedUserId_fkey" FOREIGN KEY ("nominatedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftLot" ADD CONSTRAINT "DraftLot_nominatorTeamId_fkey" FOREIGN KEY ("nominatorTeamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftLot" ADD CONSTRAINT "DraftLot_soldTeamId_fkey" FOREIGN KEY ("soldTeamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameParticipant" ADD CONSTRAINT "GameParticipant_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchLineup" ADD CONSTRAINT "MatchLineup_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchLineupSeat" ADD CONSTRAINT "MatchLineupSeat_lineupId_fkey" FOREIGN KEY ("lineupId") REFERENCES "MatchLineup"("id") ON DELETE CASCADE ON UPDATE CASCADE;


COMMIT;
