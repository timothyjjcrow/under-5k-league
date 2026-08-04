-- Additive production-readiness changes. The old application can continue to
-- use every pre-release table and column while a rollback is still possible.

BEGIN;

-- Stop before changing anything when pre-release data already violates an
-- invariant that this migration makes database-enforced. An operator must
-- reconcile the conflicting rows deliberately; choosing one here would be an
-- irreversible product decision.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "User"
    WHERE "dotaAccountId" IS NOT NULL
      AND "dotaAccountId" <= 0
  ) THEN
    RAISE EXCEPTION 'Invalid legacy Dota account id: values must be positive integers';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "User" AS holder
    INNER JOIN "User" AS owner ON owner."id" <> holder."id"
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN owner."steamId" ~ '^[0-9]{17,20}$'
          THEN owner."steamId"::numeric
        ELSE NULL
      END AS steam64
    ) AS identity
    WHERE holder."dotaAccountId" IS NOT NULL
      AND identity.steam64 > 76561197960265728
      AND identity.steam64 <= 76561202255233023
      AND holder."dotaAccountId"::numeric =
        identity.steam64 - 76561197960265728
  ) THEN
    RAISE EXCEPTION 'Cannot migrate: a legacy Dota claim collides with another user''s canonical Steam identity';
  END IF;

  IF (SELECT COUNT(*) FROM "Season" WHERE "isActive" IS TRUE) > 1 THEN
    RAISE EXCEPTION 'Cannot migrate: more than one active season exists';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM "InhouseLobby"
    WHERE "status" IN (
      'READY_CHECK',
      'CAPTAIN_VOTE',
      'DRAFTING',
      'READY',
      'IN_PROGRESS'
    )
  ) > 1 THEN
    RAISE EXCEPTION 'Cannot migrate: more than one active inhouse lobby exists';
  END IF;
END
$$;

-- Keep the old signed INTEGER column for the old binary. The v2 DOUBLE
-- PRECISION column represents every uint32 exactly and is where current code
-- writes. Copying, rather than moving, preserves rollback behavior.
ALTER TABLE "User" ADD COLUMN "dotaAccountIdV2" DOUBLE PRECISION;
UPDATE "User"
SET "dotaAccountIdV2" = "dotaAccountId"::DOUBLE PRECISION
WHERE "dotaAccountId" IS NOT NULL;
ALTER TABLE "User"
  ADD CONSTRAINT "User_dotaAccountId_unsigned_check"
  CHECK ("dotaAccountId" IS NULL OR "dotaAccountId" > 0),
  ADD CONSTRAINT "User_dotaAccountIdV2_uint32_check"
  CHECK (
    "dotaAccountIdV2" IS NULL OR (
      "dotaAccountIdV2" > 0
      AND "dotaAccountIdV2" <= 4294967295
      AND "dotaAccountIdV2" = trunc("dotaAccountIdV2")
    )
  );

ALTER TABLE "Season" ADD COLUMN "fantasyLockedAt" TIMESTAMP(3);
UPDATE "Season" AS season
SET "fantasyLockedAt" = imported."firstImportedAt"
FROM (
  SELECT
    match."seasonId",
    MIN(
      CASE
        WHEN game."startTime" > 0
          THEN to_timestamp(game."startTime") AT TIME ZONE 'UTC'
        ELSE game."fetchedAt"
      END
    ) AS "firstImportedAt"
  FROM "Game" AS game
  INNER JOIN "Match" AS match ON match."id" = game."matchId"
  GROUP BY match."seasonId"
) AS imported
WHERE season."id" = imported."seasonId"
  AND season."fantasyLockedAt" IS NULL;

ALTER TABLE "InhouseLobby" ADD COLUMN "completedAt" TIMESTAMP(3);
UPDATE "InhouseLobby"
SET "completedAt" = "updatedAt"
WHERE "status" = 'COMPLETED'
  AND "completedAt" IS NULL;

-- Add nullable first so historical rows can be deterministically backfilled
-- from their actual row-creation time instead of the migration wall clock.
ALTER TABLE "InhouseLobbyPlayer" ADD COLUMN "queuedAt" TIMESTAMP(3);
UPDATE "InhouseLobbyPlayer"
SET "queuedAt" = "createdAt"
WHERE "queuedAt" IS NULL;
ALTER TABLE "InhouseLobbyPlayer"
  ALTER COLUMN "queuedAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "queuedAt" SET NOT NULL;

CREATE TABLE "InhouseAnnouncement" (
    "id" TEXT NOT NULL,
    "lobbyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "resultMatchId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "claimToken" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InhouseAnnouncement_pkey" PRIMARY KEY ("id")
);

-- Rollback-window compatibility: migrate deploy runs before the new build is
-- promoted, so the old binary can still write for several minutes. These
-- narrowly scoped triggers keep new invariants synchronized during that
-- window and remain harmless for explicit writes from the new application.
CREATE FUNCTION "ld2l_sync_legacy_dota_account_id"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."dotaAccountId" IS NOT NULL AND NEW."dotaAccountIdV2" IS NULL THEN
      NEW."dotaAccountIdV2" := NEW."dotaAccountId"::DOUBLE PRECISION;
    END IF;
  -- Mirror only when the legacy column was the sole source of the change.
  -- An explicit v2 change in the same statement belongs to the new binary
  -- and must remain authoritative.
  ELSIF NEW."dotaAccountId" IS DISTINCT FROM OLD."dotaAccountId"
        AND NEW."dotaAccountIdV2" IS NOT DISTINCT FROM OLD."dotaAccountIdV2"
        AND OLD."dotaAccountIdV2" IS NOT DISTINCT FROM OLD."dotaAccountId"::DOUBLE PRECISION THEN
    NEW."dotaAccountIdV2" := NEW."dotaAccountId"::DOUBLE PRECISION;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "ld2l_sync_legacy_dota_account_id_trigger"
BEFORE INSERT OR UPDATE OF "dotaAccountId" ON "User"
FOR EACH ROW
EXECUTE FUNCTION "ld2l_sync_legacy_dota_account_id"();

CREATE FUNCTION "ld2l_preserve_inhouse_queue_time"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  original_queue_time TIMESTAMP(3);
BEGIN
  SELECT queue_entry."joinedAt"
  INTO original_queue_time
  FROM "InhouseQueueEntry" AS queue_entry
  WHERE queue_entry."userId" = NEW."userId";

  IF original_queue_time IS NOT NULL THEN
    NEW."queuedAt" := original_queue_time;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "ld2l_preserve_inhouse_queue_time_trigger"
BEFORE INSERT ON "InhouseLobbyPlayer"
FOR EACH ROW
EXECUTE FUNCTION "ld2l_preserve_inhouse_queue_time"();

CREATE FUNCTION "ld2l_stamp_inhouse_completion"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."status" = 'COMPLETED'
     AND OLD."status" IS DISTINCT FROM NEW."status"
     AND NEW."completedAt" IS NULL THEN
    NEW."completedAt" := CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "ld2l_stamp_inhouse_completion_trigger"
BEFORE UPDATE OF "status" ON "InhouseLobby"
FOR EACH ROW
EXECUTE FUNCTION "ld2l_stamp_inhouse_completion"();

CREATE FUNCTION "ld2l_lock_fantasy_after_game"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE "Season" AS season
  SET "fantasyLockedAt" = COALESCE(
    season."fantasyLockedAt",
    CASE
      WHEN NEW."startTime" > 0
        THEN to_timestamp(NEW."startTime") AT TIME ZONE 'UTC'
      ELSE NEW."fetchedAt"
    END
  )
  FROM "Match" AS match
  WHERE match."id" = NEW."matchId"
    AND season."id" = match."seasonId"
    AND season."fantasyLockedAt" IS NULL;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "ld2l_lock_fantasy_after_game_trigger"
AFTER INSERT ON "Game"
FOR EACH ROW
EXECUTE FUNCTION "ld2l_lock_fantasy_after_game"();

CREATE UNIQUE INDEX "User_dotaAccountIdV2_key"
  ON "User"("dotaAccountIdV2");
CREATE INDEX "NewsPost_pinned_createdAt_id_idx"
  ON "NewsPost"("pinned", "createdAt", "id");
CREATE INDEX "InhouseLobby_status_createdAt_idx"
  ON "InhouseLobby"("status", "createdAt");
CREATE INDEX "InhouseLobby_status_completedAt_idx"
  ON "InhouseLobby"("status", "completedAt");
CREATE INDEX "InhouseAnnouncement_status_availableAt_createdAt_idx"
  ON "InhouseAnnouncement"("status", "availableAt", "createdAt");
CREATE INDEX "InhouseAnnouncement_lobbyId_sequence_idx"
  ON "InhouseAnnouncement"("lobbyId", "sequence");
CREATE UNIQUE INDEX "InhouseAnnouncement_lobbyId_kind_key"
  ON "InhouseAnnouncement"("lobbyId", "kind");

-- PostgreSQL partial indexes express the real invariants without incorrectly
-- making every inactive/terminal row unique. Prisma 5.22 cannot declare these
-- in the datamodel, but it preserves them as database-native indexes.
CREATE UNIQUE INDEX "Season_one_active_idx"
  ON "Season" ((1))
  WHERE "isActive" IS TRUE;
CREATE UNIQUE INDEX "InhouseLobby_one_active_idx"
  ON "InhouseLobby" ((1))
  WHERE "status" IN (
    'READY_CHECK',
    'CAPTAIN_VOTE',
    'DRAFTING',
    'READY',
    'IN_PROGRESS'
  );

ALTER TABLE "InhouseAnnouncement"
  ADD CONSTRAINT "InhouseAnnouncement_lobbyId_fkey"
  FOREIGN KEY ("lobbyId") REFERENCES "InhouseLobby"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
