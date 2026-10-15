-- identity-us.sql: give the US database its instance identity markers (design
-- §6.1 W8). The US database on Neon predates the markers; Europe's has them.
-- scripts/instance-database.mjs then attests on every build that the database
-- belongs to region us and origin https://us.ggd2l.com.
--
--   psql -X -A -t -v ON_ERROR_STOP=1 --single-transaction -f identity-us.sql
--
-- Run it without -q: the INSERT's command tag is the count to check,
-- "INSERT 0 2" when both markers were added and "INSERT 0 0" when both were
-- already exactly right. Any other state (one marker only, another region or
-- another origin) fails before writing. The one write is a single statement,
-- so the file is safe with or without --single-transaction.
\set ON_ERROR_STOP on
DO $identity$
DECLARE configured_region text; configured_origin text;
BEGIN
  SELECT "value" INTO configured_region FROM public."Setting" WHERE "key" = 'deploymentRegion';
  SELECT "value" INTO configured_origin FROM public."Setting" WHERE "key" = 'deploymentOrigin';
  IF configured_region IS NULL AND configured_origin IS NULL THEN
    RETURN;
  END IF;
  IF configured_region IS DISTINCT FROM 'us' OR configured_origin IS DISTINCT FROM 'https://us.ggd2l.com' THEN
    RAISE EXCEPTION 'identity-us.sql: this database already carries another or a partial identity';
  END IF;
END
$identity$;

INSERT INTO public."Setting" ("key", "value")
VALUES ('deploymentRegion', 'us'), ('deploymentOrigin', 'https://us.ggd2l.com')
ON CONFLICT ("key") DO NOTHING;
