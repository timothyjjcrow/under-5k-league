const LIBPQ_QUERY_ENV = new Map([
  ["application_name", "PGAPPNAME"],
  ["channel_binding", "PGCHANNELBINDING"],
  ["client_encoding", "PGCLIENTENCODING"],
  ["connect_timeout", "PGCONNECT_TIMEOUT"],
  ["fallback_application_name", "PGAPPNAME"],
  ["gssencmode", "PGGSSENCMODE"],
  ["gsslib", "PGGSSLIB"],
  ["keepalives", "PGKEEPALIVES"],
  ["keepalives_count", "PGKEEPALIVESCOUNT"],
  ["keepalives_idle", "PGKEEPALIVESIDLE"],
  ["keepalives_interval", "PGKEEPALIVESINTERVAL"],
  ["krbsrvname", "PGKRBSRVNAME"],
  ["load_balance_hosts", "PGLOADBALANCEHOSTS"],
  ["options", "PGOPTIONS"],
  ["passfile", "PGPASSFILE"],
  ["requirepeer", "PGREQUIREPEER"],
  ["sslcert", "PGSSLCERT"],
  ["sslcrl", "PGSSLCRL"],
  ["sslcrldir", "PGSSLCRLDIR"],
  ["sslidentity", "PGSSLKEY"],
  ["sslkey", "PGSSLKEY"],
  ["sslmode", "PGSSLMODE"],
  ["sslrootcert", "PGSSLROOTCERT"],
  ["sslsni", "PGSSLSNI"],
  ["ssl_max_protocol_version", "PGSSLMAXPROTOCOLVERSION"],
  ["ssl_min_protocol_version", "PGSSLMINPROTOCOLVERSION"],
  ["target_session_attrs", "PGTARGETSESSIONATTRS"],
  ["tcp_user_timeout", "PGTCPUSERTIMEOUT"],
]);

// Prisma-only URL parameters do not affect PostgreSQL command-line clients.
// Every other option must be translated deliberately rather than ignored.
const PRISMA_ONLY_QUERY_PARAMS = new Set([
  "connection_limit",
  "pgbouncer",
  "pool_timeout",
  "schema",
  "socket_timeout",
  "sslaccept",
  "sslpassword",
]);

const LIBPQ_VARIABLES = [
  ...new Set(LIBPQ_QUERY_ENV.values()),
  "PGDATABASE",
  "PGHOST",
  "PGPASSWORD",
  "PGPORT",
  "PGUSER",
];

/**
 * Translate one PostgreSQL URL into libpq environment variables. Credentials
 * stay out of argv/process listings, and inherited PG* variables cannot point
 * a child process at a different database.
 */
export function postgresCliEnv(raw, options = {}) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("PostgreSQL URL must be a valid connection URL");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("PostgreSQL URL must use postgres:// or postgresql://");
  }

  const originalDatabase = decode(parsed.pathname.replace(/^\//, ""));
  const database = options.database ?? originalDatabase;
  const user = decode(parsed.username);
  const password = decode(parsed.password);
  if (!parsed.hostname || !user || !database || !originalDatabase) {
    throw new Error("PostgreSQL URL must include host, user, and database");
  }
  if (options.database !== undefined && !/^[a-zA-Z0-9_]+$/.test(database)) {
    throw new Error("PostgreSQL database override contains unsupported characters");
  }

  const env = { ...(options.env ?? process.env) };
  delete env.DATABASE_URL;
  delete env.DIRECT_URL;
  delete env.PG_RESTORE_TEST_URL;
  for (const variable of LIBPQ_VARIABLES) delete env[variable];

  env.PGHOST = parsed.hostname;
  env.PGDATABASE = database;
  env.PGUSER = user;
  if (parsed.port) env.PGPORT = parsed.port;
  if (password) env.PGPASSWORD = password;

  for (const [key, value] of parsed.searchParams) {
    const variable = LIBPQ_QUERY_ENV.get(key);
    if (variable) {
      env[variable] = value;
    } else if (!PRISMA_ONLY_QUERY_PARAMS.has(key)) {
      throw new Error(`unsupported PostgreSQL URL parameter: ${key}`);
    }
  }
  return env;
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("PostgreSQL URL contains invalid percent encoding");
  }
}
