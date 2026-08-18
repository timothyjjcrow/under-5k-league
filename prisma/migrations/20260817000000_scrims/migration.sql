-- Casual team scrims reuse a season's Valve league ticket while keeping their
-- schedule, lineups, games, and statistics isolated from league competition.

BEGIN;

CREATE TABLE "TeamStaff" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'COACH',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamStaff_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Scrim" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "hostTeamId" TEXT NOT NULL,
    "opponentTeamId" TEXT,
    "createdById" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "bestOf" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "hostScore" INTEGER NOT NULL DEFAULT 0,
    "awayScore" INTEGER NOT NULL DEFAULT 0,
    "winnerTeamId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Scrim_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScrimParticipant" (
    "id" TEXT NOT NULL,
    "scrimId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT,
    "dotaAccountId" DOUBLE PRECISION NOT NULL,
    "displayName" TEXT NOT NULL,
    "guest" BOOLEAN NOT NULL DEFAULT false,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScrimParticipant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScrimGame" (
    "id" TEXT NOT NULL,
    "scrimId" TEXT NOT NULL,
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

    CONSTRAINT "ScrimGame_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DotaMatchClaim" (
    "dotaMatchId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "contextId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DotaMatchClaim_pkey" PRIMARY KEY ("dotaMatchId")
);

CREATE UNIQUE INDEX "TeamStaff_teamId_userId_key"
    ON "TeamStaff"("teamId", "userId");
CREATE INDEX "TeamStaff_userId_idx"
    ON "TeamStaff"("userId");

CREATE INDEX "Scrim_seasonId_status_scheduledAt_idx"
    ON "Scrim"("seasonId", "status", "scheduledAt");
CREATE INDEX "Scrim_hostTeamId_idx"
    ON "Scrim"("hostTeamId");
CREATE INDEX "Scrim_opponentTeamId_idx"
    ON "Scrim"("opponentTeamId");
CREATE INDEX "Scrim_winnerTeamId_idx"
    ON "Scrim"("winnerTeamId");
CREATE INDEX "Scrim_createdById_idx"
    ON "Scrim"("createdById");

CREATE UNIQUE INDEX "ScrimParticipant_scrimId_dotaAccountId_key"
    ON "ScrimParticipant"("scrimId", "dotaAccountId");
CREATE INDEX "ScrimParticipant_scrimId_teamId_idx"
    ON "ScrimParticipant"("scrimId", "teamId");
CREATE INDEX "ScrimParticipant_teamId_idx"
    ON "ScrimParticipant"("teamId");
CREATE INDEX "ScrimParticipant_userId_idx"
    ON "ScrimParticipant"("userId");
CREATE INDEX "ScrimParticipant_addedById_idx"
    ON "ScrimParticipant"("addedById");

CREATE UNIQUE INDEX "ScrimGame_dotaMatchId_key"
    ON "ScrimGame"("dotaMatchId");
CREATE INDEX "ScrimGame_scrimId_idx"
    ON "ScrimGame"("scrimId");

CREATE INDEX "DotaMatchClaim_kind_contextId_idx"
    ON "DotaMatchClaim"("kind", "contextId");

ALTER TABLE "TeamStaff" ADD CONSTRAINT "TeamStaff_teamId_fkey"
    FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamStaff" ADD CONSTRAINT "TeamStaff_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Scrim" ADD CONSTRAINT "Scrim_seasonId_fkey"
    FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Scrim" ADD CONSTRAINT "Scrim_hostTeamId_fkey"
    FOREIGN KEY ("hostTeamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Scrim" ADD CONSTRAINT "Scrim_opponentTeamId_fkey"
    FOREIGN KEY ("opponentTeamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Scrim" ADD CONSTRAINT "Scrim_winnerTeamId_fkey"
    FOREIGN KEY ("winnerTeamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Scrim" ADD CONSTRAINT "Scrim_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ScrimParticipant" ADD CONSTRAINT "ScrimParticipant_scrimId_fkey"
    FOREIGN KEY ("scrimId") REFERENCES "Scrim"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScrimParticipant" ADD CONSTRAINT "ScrimParticipant_teamId_fkey"
    FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScrimParticipant" ADD CONSTRAINT "ScrimParticipant_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ScrimParticipant" ADD CONSTRAINT "ScrimParticipant_addedById_fkey"
    FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ScrimGame" ADD CONSTRAINT "ScrimGame_scrimId_fkey"
    FOREIGN KEY ("scrimId") REFERENCES "Scrim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
