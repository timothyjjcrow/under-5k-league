-- Exact PostgreSQL baseline generated from commit 5520873 (b92b6d5^).
-- Existing databases must pass scripts/migration-baseline-check.mjs before
-- this migration is marked applied with `prisma migrate resolve`.

BEGIN;

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "steamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatar" TEXT,
    "profileUrl" TEXT,
    "dotaAccountId" INTEGER,
    "rankTier" INTEGER,
    "fhUnavailable" BOOLEAN,
    "pubStats" TEXT,
    "pubStatsAt" TIMESTAMP(3),
    "discordName" TEXT NOT NULL DEFAULT '',
    "discordId" TEXT,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsPost" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NewsPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Season" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SIGNUPS',
    "minTeams" INTEGER NOT NULL DEFAULT 4,
    "teamSize" INTEGER NOT NULL DEFAULT 5,
    "draftBudget" INTEGER NOT NULL DEFAULT 100,
    "budgetMmrWeight" INTEGER NOT NULL DEFAULT 20,
    "maxMmr" INTEGER NOT NULL DEFAULT 0,
    "regularBestOf" INTEGER NOT NULL DEFAULT 2,
    "playoffBestOf" INTEGER NOT NULL DEFAULT 3,
    "finalBestOf" INTEGER NOT NULL DEFAULT 5,
    "currentWeek" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "championTeamId" TEXT,
    "dotaLeagueId" TEXT,
    "matchSchedule" TEXT,
    "firstMatchNight" TIMESTAMP(3),
    "draftAt" TIMESTAMP(3),
    "draftRevision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Registration" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'PLAYER',
    "mmr" INTEGER NOT NULL DEFAULT 0,
    "wantsCaptain" BOOLEAN NOT NULL DEFAULT false,
    "roles" TEXT NOT NULL DEFAULT '',
    "favoriteHeroes" TEXT NOT NULL DEFAULT '',
    "statement" TEXT NOT NULL DEFAULT '',
    "captainNote" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "draftConfirmedRevision" INTEGER,
    "draftConfirmedAt" TIMESTAMP(3),
    "draftConfirmedFor" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Registration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "captainId" TEXT NOT NULL,
    "budget" INTEGER NOT NULL DEFAULT 100,
    "draftOrder" INTEGER NOT NULL DEFAULT 0,
    "withdrawn" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "price" INTEGER NOT NULL DEFAULT 0,
    "isCaptain" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Draft" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "nominatorTeamId" TEXT,
    "nominatedUserId" TEXT,
    "currentBid" INTEGER NOT NULL DEFAULT 0,
    "currentBidTeamId" TEXT,
    "bidEndsAt" TIMESTAMP(3),
    "nominationEndsAt" TIMESTAMP(3),
    "nominationIndex" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bid" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "week" INTEGER NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'REGULAR',
    "homeTeamId" TEXT NOT NULL,
    "awayTeamId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "homeScore" INTEGER NOT NULL DEFAULT 0,
    "awayScore" INTEGER NOT NULL DEFAULT 0,
    "bestOf" INTEGER NOT NULL DEFAULT 1,
    "winnerTeamId" TEXT,
    "bracketSlot" TEXT,
    "forfeit" BOOLEAN NOT NULL DEFAULT false,
    "autoSyncedAt" TIMESTAMP(3),
    "autoSyncAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RescheduleRequest" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "proposedById" TEXT NOT NULL,
    "proposedTime" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RescheduleRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchAvailability" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StandinAssignment" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "standinUserId" TEXT NOT NULL,
    "replacingUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StandinAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Game" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "dotaMatchId" TEXT NOT NULL,
    "radiantWin" BOOLEAN NOT NULL,
    "durationSecs" INTEGER NOT NULL DEFAULT 0,
    "startTime" INTEGER NOT NULL DEFAULT 0,
    "radiantScore" INTEGER NOT NULL DEFAULT 0,
    "direScore" INTEGER NOT NULL DEFAULT 0,
    "radiantTeamId" TEXT,
    "direTeamId" TEXT,
    "winnerTeamId" TEXT,
    "players" TEXT NOT NULL DEFAULT '[]',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Game_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AdminAction" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "seasonId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FantasyRoster" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FantasyRoster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FantasyPick" (
    "id" TEXT NOT NULL,
    "rosterId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "FantasyPick_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prediction" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pickedTeamId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Prediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InhouseQueueEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mmr" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InhouseQueueEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InhouseLobby" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'READY_CHECK',
    "acceptEndsAt" TIMESTAMP(3),
    "voteEndsAt" TIMESTAMP(3),
    "pickTeam" INTEGER,
    "pickEndsAt" TIMESTAMP(3),
    "radiantTeam" INTEGER NOT NULL DEFAULT 1,
    "winnerTeam" INTEGER,
    "startedById" TEXT,
    "startedAt" TIMESTAMP(3),
    "dotaMatchId" TEXT,
    "detectedAt" TIMESTAMP(3),
    "durationSecs" INTEGER,
    "radiantScore" INTEGER,
    "direScore" INTEGER,
    "boxScore" TEXT NOT NULL DEFAULT '[]',
    "eloDeltas" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "betsCloseAt" TIMESTAMP(3),
    "betSettlement" TEXT,
    "matchStartTime" TIMESTAMP(3),
    "betDeltas" TEXT NOT NULL DEFAULT '{}',

    CONSTRAINT "InhouseLobby_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InhouseLobbyPlayer" (
    "id" TEXT NOT NULL,
    "lobbyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "team" INTEGER,
    "isCaptain" BOOLEAN NOT NULL DEFAULT false,
    "pickIndex" INTEGER,
    "mmr" INTEGER NOT NULL DEFAULT 0,
    "acceptedAt" TIMESTAMP(3),
    "votedMethod" TEXT,
    "votedNomineeId" TEXT,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "games" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InhouseLobbyPlayer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InhouseBet" (
    "id" TEXT NOT NULL,
    "lobbyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "team" INTEGER NOT NULL,
    "stake" INTEGER NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "matched" INTEGER,
    "payout" INTEGER,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "InhouseBet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InhouseCredit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 500,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InhouseCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InhouseCreditEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "lobbyId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InhouseCreditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_steamId_key" ON "User"("steamId");

-- CreateIndex
CREATE UNIQUE INDEX "User_dotaAccountId_key" ON "User"("dotaAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "User_discordId_key" ON "User"("discordId");

-- CreateIndex
CREATE INDEX "Registration_seasonId_status_type_idx" ON "Registration"("seasonId", "status", "type");

-- CreateIndex
CREATE INDEX "Registration_userId_idx" ON "Registration"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Registration_seasonId_userId_key" ON "Registration"("seasonId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Team_seasonId_captainId_key" ON "Team"("seasonId", "captainId");

-- CreateIndex
CREATE INDEX "TeamMember_teamId_idx" ON "TeamMember"("teamId");

-- CreateIndex
CREATE INDEX "TeamMember_userId_idx" ON "TeamMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMember_seasonId_userId_key" ON "TeamMember"("seasonId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Draft_seasonId_key" ON "Draft"("seasonId");

-- CreateIndex
CREATE INDEX "Bid_draftId_idx" ON "Bid"("draftId");

-- CreateIndex
CREATE INDEX "Match_seasonId_idx" ON "Match"("seasonId");

-- CreateIndex
CREATE INDEX "Match_homeTeamId_idx" ON "Match"("homeTeamId");

-- CreateIndex
CREATE INDEX "Match_awayTeamId_idx" ON "Match"("awayTeamId");

-- CreateIndex
CREATE INDEX "RescheduleRequest_matchId_status_idx" ON "RescheduleRequest"("matchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MatchAvailability_matchId_userId_key" ON "MatchAvailability"("matchId", "userId");

-- CreateIndex
CREATE INDEX "StandinAssignment_matchId_idx" ON "StandinAssignment"("matchId");

-- CreateIndex
CREATE UNIQUE INDEX "Game_dotaMatchId_key" ON "Game"("dotaMatchId");

-- CreateIndex
CREATE INDEX "Game_matchId_idx" ON "Game"("matchId");

-- CreateIndex
CREATE INDEX "AdminAction_createdAt_idx" ON "AdminAction"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FantasyRoster_seasonId_userId_key" ON "FantasyRoster"("seasonId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "FantasyPick_rosterId_userId_key" ON "FantasyPick"("rosterId", "userId");

-- CreateIndex
CREATE INDEX "Prediction_userId_idx" ON "Prediction"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Prediction_matchId_userId_key" ON "Prediction"("matchId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "InhouseQueueEntry_userId_key" ON "InhouseQueueEntry"("userId");

-- CreateIndex
CREATE INDEX "InhouseLobby_status_idx" ON "InhouseLobby"("status");

-- CreateIndex
CREATE INDEX "InhouseLobby_betSettlement_idx" ON "InhouseLobby"("betSettlement");

-- CreateIndex
CREATE INDEX "InhouseLobbyPlayer_userId_idx" ON "InhouseLobbyPlayer"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "InhouseLobbyPlayer_lobbyId_userId_key" ON "InhouseLobbyPlayer"("lobbyId", "userId");

-- CreateIndex
CREATE INDEX "InhouseBet_userId_idx" ON "InhouseBet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "InhouseBet_lobbyId_userId_key" ON "InhouseBet"("lobbyId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "InhouseCredit_userId_key" ON "InhouseCredit"("userId");

-- CreateIndex
CREATE INDEX "InhouseCreditEntry_userId_idx" ON "InhouseCreditEntry"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "InhouseCreditEntry_reason_refId_key" ON "InhouseCreditEntry"("reason", "refId");

-- AddForeignKey
ALTER TABLE "NewsPost" ADD CONSTRAINT "NewsPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Registration" ADD CONSTRAINT "Registration_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Registration" ADD CONSTRAINT "Registration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_captainId_fkey" FOREIGN KEY ("captainId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "Draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_homeTeamId_fkey" FOREIGN KEY ("homeTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_awayTeamId_fkey" FOREIGN KEY ("awayTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RescheduleRequest" ADD CONSTRAINT "RescheduleRequest_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RescheduleRequest" ADD CONSTRAINT "RescheduleRequest_proposedById_fkey" FOREIGN KEY ("proposedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchAvailability" ADD CONSTRAINT "MatchAvailability_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchAvailability" ADD CONSTRAINT "MatchAvailability_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StandinAssignment" ADD CONSTRAINT "StandinAssignment_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StandinAssignment" ADD CONSTRAINT "StandinAssignment_standinUserId_fkey" FOREIGN KEY ("standinUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StandinAssignment" ADD CONSTRAINT "StandinAssignment_replacingUserId_fkey" FOREIGN KEY ("replacingUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Game" ADD CONSTRAINT "Game_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FantasyRoster" ADD CONSTRAINT "FantasyRoster_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FantasyRoster" ADD CONSTRAINT "FantasyRoster_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FantasyPick" ADD CONSTRAINT "FantasyPick_rosterId_fkey" FOREIGN KEY ("rosterId") REFERENCES "FantasyRoster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FantasyPick" ADD CONSTRAINT "FantasyPick_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prediction" ADD CONSTRAINT "Prediction_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prediction" ADD CONSTRAINT "Prediction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prediction" ADD CONSTRAINT "Prediction_pickedTeamId_fkey" FOREIGN KEY ("pickedTeamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InhouseQueueEntry" ADD CONSTRAINT "InhouseQueueEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InhouseLobby" ADD CONSTRAINT "InhouseLobby_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InhouseLobbyPlayer" ADD CONSTRAINT "InhouseLobbyPlayer_lobbyId_fkey" FOREIGN KEY ("lobbyId") REFERENCES "InhouseLobby"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InhouseLobbyPlayer" ADD CONSTRAINT "InhouseLobbyPlayer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InhouseBet" ADD CONSTRAINT "InhouseBet_lobbyId_fkey" FOREIGN KEY ("lobbyId") REFERENCES "InhouseLobby"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InhouseBet" ADD CONSTRAINT "InhouseBet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InhouseCredit" ADD CONSTRAINT "InhouseCredit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
