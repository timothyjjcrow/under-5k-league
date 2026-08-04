// Fail before a production build can touch the database when deployment
// credentials are missing, unsafe, or internally inconsistent. Vercel sets
// NODE_ENV=production for preview builds too, so an explicit non-production
// VERCEL_ENV always wins and skips this production-only gate.
import { postgresDatabaseIdentity } from "../src/lib/postgres-identity.mjs";

// Individual Steam accounts are universe/type/instance base 76561197960265728
// plus an unsigned 32-bit account id. A 17-digit shape check alone accepts
// group IDs and impossible account values, so pin the actual individual range.
const STEAM_ID_64_MIN = 76561197960265728n;
const STEAM_ID_64_MAX = 76561202255233023n;
const KNOWN_AUTH_SECRET_PLACEHOLDERS = new Set([
  "change-me-to-a-long-random-string-min-32-chars",
  "insecure-dev-secret-please-change-0123456789abcd",
  "replace-with-a-random-secret-of-at-least-32-characters",
]);

function productionBuild(env) {
  if (env.VERCEL_ENV) return env.VERCEL_ENV === "production";
  return env.NODE_ENV === "production";
}

function postgresUrl(value) {
  return postgresDatabaseIdentity(value) !== null;
}

function httpsOrigin(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && value === url.origin ? url.origin : null;
  } catch {
    return null;
  }
}

function steamId64(value) {
  if (!/^\d{17}$/.test(value)) return false;
  const numeric = BigInt(value);
  return numeric >= STEAM_ID_64_MIN && numeric <= STEAM_ID_64_MAX;
}

function placeholderSecret(value) {
  const trimmed = value.trim();
  return (
    value !== trimmed ||
    KNOWN_AUTH_SECRET_PLACEHOLDERS.has(trimmed) ||
    /(?:change[-_ ]?me|replace[-_ ]?with|placeholder|example[-_ ]?secret|your[-_ ]?secret|secret[-_ ]?here|development[-_ ]?secret|todo)/i.test(
      trimmed,
    ) ||
    new Set(trimmed).size < 8
  );
}

export function validateProductionEnv(env) {
  const errors = [];

  if (env.BUILD_DB_DRY_RUN !== undefined) {
    errors.push("BUILD_DB_DRY_RUN is test-only and must be unset in production");
  }

  if (!postgresUrl(env.DATABASE_URL)) {
    errors.push("DATABASE_URL must be a PostgreSQL connection URL with a database name");
  }
  if (!postgresUrl(env.DIRECT_URL)) {
    errors.push("DIRECT_URL must be a direct PostgreSQL connection URL with a database name");
  }
  const pooledIdentity = postgresDatabaseIdentity(env.DATABASE_URL);
  const directIdentity = postgresDatabaseIdentity(env.DIRECT_URL);
  if (pooledIdentity && directIdentity && pooledIdentity !== directIdentity) {
    errors.push(
      "DATABASE_URL and DIRECT_URL must identify the same PostgreSQL user, database, and endpoint",
    );
  }

  const receiptSecret = env.BACKUP_RECEIPT_SECRET ?? "";
  if (receiptSecret.length < 32) {
    errors.push("BACKUP_RECEIPT_SECRET must contain at least 32 characters");
  } else if (placeholderSecret(receiptSecret)) {
    errors.push(
      "BACKUP_RECEIPT_SECRET must not be a documented or recognizable placeholder",
    );
  }

  const secret = env.AUTH_SECRET ?? "";
  if (secret.length < 32) {
    errors.push("AUTH_SECRET must contain at least 32 characters");
  } else if (placeholderSecret(secret)) {
    errors.push("AUTH_SECRET must not be a documented or recognizable placeholder");
  }
  if (secret && receiptSecret && secret === receiptSecret) {
    errors.push("BACKUP_RECEIPT_SECRET must be different from AUTH_SECRET");
  }

  const adminIds = (env.ADMIN_STEAM_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (adminIds.length === 0) {
    errors.push("ADMIN_STEAM_IDS must contain at least one trusted SteamID64");
  } else {
    const invalid = adminIds.filter((value) => !steamId64(value));
    if (invalid.length > 0) {
      errors.push(
        "every ADMIN_STEAM_IDS entry must be a valid individual SteamID64",
      );
    }
    if (new Set(adminIds).size !== adminIds.length) {
      errors.push("ADMIN_STEAM_IDS must not contain duplicate SteamID64s");
    }
  }

  const appOrigin = httpsOrigin(env.APP_URL);
  const publicOrigin = httpsOrigin(env.NEXT_PUBLIC_SITE_URL);
  if (!appOrigin) {
    errors.push("APP_URL must be one canonical HTTPS origin with no path or trailing slash");
  }
  if (!publicOrigin) {
    errors.push(
      "NEXT_PUBLIC_SITE_URL must be one canonical HTTPS origin with no path or trailing slash",
    );
  }
  if (appOrigin && publicOrigin && appOrigin !== publicOrigin) {
    errors.push("APP_URL and NEXT_PUBLIC_SITE_URL must use the same canonical origin");
  }

  if (env.ALLOW_DEV_LOGIN && env.ALLOW_DEV_LOGIN !== "false") {
    errors.push("ALLOW_DEV_LOGIN must be unset or exactly false in production");
  }

  return errors;
}

if (!productionBuild(process.env)) {
  console.log(
    `validate-prod-env: VERCEL_ENV=${process.env.VERCEL_ENV ?? "(unset)"} — production validation skipped`,
  );
} else {
  const errors = validateProductionEnv(process.env);
  if (errors.length > 0) {
    console.error("Production environment validation failed:");
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
  } else {
    console.log("Production environment validation passed.");
  }
}
