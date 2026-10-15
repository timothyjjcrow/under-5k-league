-- scrub-rehearsal.sql: make a restored copy unable to reach Discord (design §4).
-- Only for the rehearsal copy that the cutover import later drops and replaces;
-- never for a live league database.
--
--   psql -X -q -A -t -v ON_ERROR_STOP=1 -v confirm=scrub-ggd2l_us -f scrub-rehearsal.sql
--
-- confirm must be "scrub-" plus the database you are connected to, so the file
-- cannot run against a database nobody named; without it the run fails.
--
-- Deletes the four webhook Setting rows and the stored queue board and status
-- card (src/lib/settings.ts: an absent row turns that feature off). Prints the
-- KEYS it removed, never their values: webhook URLs are credentials.
\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('ggd2l.scrub_confirm', :'confirm', true) AS confirm \gset ggd2l_
DO $confirm$
BEGIN
  IF current_setting('ggd2l.scrub_confirm') IS DISTINCT FROM 'scrub-' || current_database() THEN
    RAISE EXCEPTION 'scrub-rehearsal.sql: pass -v confirm=scrub-<this database name>';
  END IF;
END
$confirm$;

WITH removed AS (
  DELETE FROM public."Setting"
  WHERE "key" IN (
    'discordWebhookUrl',
    'inhouseWebhookUrl',
    'inhouseAlertWebhookUrl',
    'leagueStatusWebhookUrl',
    'inhouseBoard',
    'leagueStatusCard'
  )
  RETURNING "key"
)
SELECT concat_ws(E'\t', 'removed', "key") FROM removed ORDER BY "key" COLLATE "C";
COMMIT;
