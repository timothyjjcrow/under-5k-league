-- db-parity.sql: a read-only fingerprint of one league database (design §10
-- G-DATA), run on both sides of a move and diffed: Neon before, the box after.
--
--   psql -X -q -A -t -v ON_ERROR_STOP=1 -f db-parity.sql
--
-- Same client flags on both sides; then `diff` the two outputs. It writes
-- nothing (Neon is read-only during the cutover), so it creates no temporary
-- object either: \gexec runs one generated SELECT per table.
--
-- Output, one line each, tab-separated, in a fixed order:
--   table      <name> <row count> <md5 of the sorted row texts>
--   migration  <the full _prisma_migrations row text>
-- Row text is the record's text form under the session settings below, so
-- both servers render timestamps, floats, intervals and bytes identically,
-- and the sort uses the C collation whatever the database's own locale.
\set ON_ERROR_STOP on
SET TimeZone = 'UTC';
SET DateStyle = 'ISO, YMD';
SET extra_float_digits = 1;
SET IntervalStyle = 'postgres';
SET bytea_output = 'hex';

SELECT format(
  $query$SELECT concat_ws(E'\t', 'table', %L, count(*), md5(coalesce(string_agg(r.t, E'\n' ORDER BY r.t COLLATE "C"), ''))) FROM (SELECT x::text AS t FROM %I.%I AS x) AS r$query$,
  c.relname, n.nspname, c.relname)
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
ORDER BY c.relname COLLATE "C"
\gexec

SELECT concat_ws(E'\t', 'migration', m::text)
FROM public._prisma_migrations AS m
ORDER BY m.migration_name COLLATE "C", m.id COLLATE "C";
