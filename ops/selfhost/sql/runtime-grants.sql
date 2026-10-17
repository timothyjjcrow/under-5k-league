-- runtime-grants.sql: what the league's runtime (app) role can and cannot do
-- (design §3, D17). Run against the league database, as its owner or postgres:
--
--   psql -X -q -A -t -v ON_ERROR_STOP=1 -v app=ggd2l_us_app -f runtime-grants.sql
--
-- Every output row names one problem (label:relation, printable as is); ZERO
-- rows means the grants are right.
-- A missing -v app is a syntax error, and an unknown role is an error, so a
-- mistyped call exits non-zero instead of printing an empty (passing) result.
\set ON_ERROR_STOP on

-- Every application table: full DML for the app role.
SELECT 'app-lacks-dml:' || c.relname
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> '_prisma_migrations'
  -- CASE keeps the planner from probing privileges on other relation kinds.
  AND CASE WHEN n.nspname = 'public' AND c.relkind IN ('r', 'p') THEN
        NOT (has_table_privilege(:'app', c.oid, 'SELECT') AND has_table_privilege(:'app', c.oid, 'INSERT')
         AND has_table_privilege(:'app', c.oid, 'UPDATE') AND has_table_privilege(:'app', c.oid, 'DELETE'))
      ELSE false END
-- Sequences (none today): a future autoincrement column must keep working.
UNION ALL
SELECT 'app-cannot-use-sequence:' || c.relname
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'S'
  AND CASE WHEN c.relkind = 'S' THEN NOT has_sequence_privilege(:'app', c.oid, 'USAGE') ELSE false END
-- The app never creates, owns or alters schema objects: only the owner does.
UNION ALL SELECT 'app-can-create' WHERE has_schema_privilege(:'app', 'public', 'CREATE')
UNION ALL SELECT 'app-can-create-schema' WHERE has_database_privilege(:'app', current_database(), 'CREATE')
UNION ALL SELECT 'app-owns:' || relname FROM pg_catalog.pg_class WHERE relowner = to_regrole(:'app')::oid
UNION ALL SELECT 'app-owns-schema:' || nspname FROM pg_catalog.pg_namespace WHERE nspowner = to_regrole(:'app')::oid
UNION ALL SELECT 'app-owns-database' FROM pg_catalog.pg_database
  WHERE datname = current_database() AND datdba = to_regrole(:'app')::oid
UNION ALL SELECT 'app-has-role-attributes' FROM pg_catalog.pg_roles
  WHERE rolname = :'app' AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
UNION ALL SELECT 'app-member-of:' || pg_catalog.pg_get_userbyid(m.roleid)
  FROM pg_catalog.pg_auth_members AS m WHERE m.member = to_regrole(:'app')::oid
-- The migration ledger: readable (the build attests the schema with it), never
-- writable by the runtime.
UNION ALL SELECT 'ledger-missing' WHERE to_regclass('public._prisma_migrations') IS NULL
UNION ALL SELECT 'app-cannot-read-ledger'
  WHERE NOT coalesce(has_table_privilege(:'app', to_regclass('public._prisma_migrations'), 'SELECT'), false)
UNION ALL SELECT 'app-can-write-ledger'
  WHERE coalesce(has_table_privilege(:'app', to_regclass('public._prisma_migrations'), 'INSERT, UPDATE, DELETE'), false)
-- Nothing else may reach the league's data.
UNION ALL SELECT 'public-can-connect' WHERE has_database_privilege('public', current_database(), 'CONNECT')
UNION ALL SELECT 'public-can-use-schema' WHERE has_schema_privilege('public', 'public', 'USAGE')
-- Ownership (G-DATA): every relation and function in public belongs to the
-- database owner, so a restore made as anyone else shows up here.
UNION ALL
SELECT 'not-owned-by-database-owner:' || c.relname
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  AND c.relowner <> (SELECT datdba FROM pg_catalog.pg_database WHERE datname = current_database())
UNION ALL
SELECT 'not-owned-by-database-owner:function:' || p.proname
FROM pg_catalog.pg_proc AS p
JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proowner <> (SELECT datdba FROM pg_catalog.pg_database WHERE datname = current_database())
ORDER BY 1;
