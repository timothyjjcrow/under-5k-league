BEGIN;

CREATE TABLE "AutomationRunState" (
    "key" TEXT NOT NULL,
    "leaseToken" TEXT,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "lastStartedAt" TIMESTAMP(3),
    "lastFinishedAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastStatus" TEXT NOT NULL DEFAULT 'NEVER',
    "lastSource" TEXT,
    "lastDurationMs" INTEGER,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "lastSummary" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationRunState_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "LeagueAnnouncement" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "content" TEXT NOT NULL,
    "mentions" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "claimToken" TEXT,
    "markerKey" TEXT,
    "markerEventId" TEXT,
    "lastErrorCode" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeagueAnnouncement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LeagueAnnouncement_dedupeKey_key"
    ON "LeagueAnnouncement"("dedupeKey");

CREATE INDEX "LeagueAnnouncement_status_availableAt_createdAt_idx"
    ON "LeagueAnnouncement"("status", "availableAt", "createdAt");

CREATE INDEX "LeagueAnnouncement_markerKey_status_idx"
    ON "LeagueAnnouncement"("markerKey", "status");

ALTER TABLE "Match"
    ADD COLUMN "completedAt" TIMESTAMP(3);

CREATE INDEX "Match_seasonId_status_completedAt_idx"
    ON "Match"("seasonId", "status", "completedAt");

CREATE FUNCTION "ld2l_stamp_match_completion"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW."status" = 'COMPLETED' THEN
        IF TG_OP = 'INSERT' THEN
            NEW."completedAt" := COALESCE(NEW."completedAt", CURRENT_TIMESTAMP);
        ELSIF OLD."status" IS DISTINCT FROM 'COMPLETED'
           OR OLD."homeScore" IS DISTINCT FROM NEW."homeScore"
           OR OLD."awayScore" IS DISTINCT FROM NEW."awayScore"
           OR OLD."winnerTeamId" IS DISTINCT FROM NEW."winnerTeamId"
           OR OLD."forfeit" IS DISTINCT FROM NEW."forfeit" THEN
            NEW."completedAt" := COALESCE(NEW."completedAt", CURRENT_TIMESTAMP);
        ELSE
            NEW."completedAt" := COALESCE(NEW."completedAt", OLD."completedAt");
        END IF;
    ELSE
        NEW."completedAt" := NULL;
    END IF;
    RETURN NEW;
END
$function$;

CREATE TRIGGER "ld2l_stamp_match_completion_trigger"
BEFORE INSERT OR UPDATE OF "status", "homeScore", "awayScore", "winnerTeamId", "forfeit" ON "Match"
FOR EACH ROW
EXECUTE FUNCTION "ld2l_stamp_match_completion"();

COMMIT;
