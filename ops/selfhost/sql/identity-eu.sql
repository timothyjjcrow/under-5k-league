-- identity-eu.sql: move the Europe database's origin marker to the box's
-- hostname (design §6.2 E5). Run it only AFTER the parity check, which compares
-- the restored copy with Neon as it was.
--
--   psql -X -A -t -v ON_ERROR_STOP=1 --single-transaction -f identity-eu.sql
--
-- Run it without -q: the UPDATE's command tag is the count to check,
-- "UPDATE 1" when the origin moved from https://ggd2l-europe.vercel.app and
-- "UPDATE 0" when it already reads https://eu.ggd2l.com. Anything else (no
-- Europe region marker, or another origin) fails the check after it, which
-- the update could not have touched.
\set ON_ERROR_STOP on
UPDATE public."Setting" SET "value" = 'https://eu.ggd2l.com'
WHERE "key" = 'deploymentOrigin' AND "value" = 'https://ggd2l-europe.vercel.app'
  AND EXISTS (SELECT 1 FROM public."Setting" WHERE "key" = 'deploymentRegion' AND "value" = 'eu');

DO $identity$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."Setting" WHERE "key" = 'deploymentRegion' AND "value" = 'eu')
     OR NOT EXISTS (SELECT 1 FROM public."Setting" WHERE "key" = 'deploymentOrigin' AND "value" = 'https://eu.ggd2l.com') THEN
    RAISE EXCEPTION 'identity-eu.sql: this database is not Europe''s, or names another origin';
  END IF;
END
$identity$;
