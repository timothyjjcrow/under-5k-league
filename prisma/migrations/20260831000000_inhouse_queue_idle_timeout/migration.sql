-- Give the waiting queue one durable inactivity deadline. The application
-- refreshes every row together only when membership changes; presence
-- heartbeats deliberately leave this column untouched.

BEGIN;

ALTER TABLE "InhouseQueueEntry" ADD COLUMN "idleExpiresAt" TIMESTAMP(3);

-- Treat the latest join as the best available pre-release composition change.
-- This expires a one-player queue that has already been static for four hours
-- instead of granting it a fresh four-hour window at deploy time.
UPDATE "InhouseQueueEntry"
SET "idleExpiresAt" = (
    SELECT MAX(queue."joinedAt") + INTERVAL '4 hours'
    FROM "InhouseQueueEntry" AS queue
);

-- migrate deploy runs before the new binary is promoted. Keep semantic queue
-- changes made by the old binary coherent during that rollback window too.
-- Statement-level is deliberate: a multi-row formation/removal refreshes the
-- survivors once, after the complete delete, rather than once per removed row.
CREATE FUNCTION "ld2l_refresh_inhouse_queue_idle_deadline"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- Statement triggers fire even when zero rows match. The transition table
  -- keeps maintenance no-ops and ON CONFLICT updates from renewing the queue.
  IF EXISTS (SELECT 1 FROM changed_queue_rows) THEN
    UPDATE "InhouseQueueEntry"
    SET "idleExpiresAt" =
      (statement_timestamp() AT TIME ZONE 'UTC') + INTERVAL '4 hours';
  END IF;
  RETURN NULL;
END
$function$;

CREATE TRIGGER "ld2l_refresh_inhouse_queue_idle_deadline_insert_trigger"
AFTER INSERT ON "InhouseQueueEntry"
REFERENCING NEW TABLE AS changed_queue_rows
FOR EACH STATEMENT
EXECUTE FUNCTION "ld2l_refresh_inhouse_queue_idle_deadline"();

CREATE TRIGGER "ld2l_refresh_inhouse_queue_idle_deadline_delete_trigger"
AFTER DELETE ON "InhouseQueueEntry"
REFERENCING OLD TABLE AS changed_queue_rows
FOR EACH STATEMENT
EXECUTE FUNCTION "ld2l_refresh_inhouse_queue_idle_deadline"();

COMMIT;
