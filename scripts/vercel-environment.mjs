const VERCEL_ENVIRONMENTS = new Set([
  "production",
  "preview",
  "development",
]);

// Prisma validate/generate need syntactically valid datasource URLs. A
// non-production build without a database of its own gets this inert
// loopback URL (scripts/vercel-build.mjs), which nothing ever connects to.
export const INERT_BUILD_DATABASE_URL =
  "postgresql://preview_build:preview_build@127.0.0.1:1/preview_build";

/**
 * Decide whether production-only release gates are required. An explicitly
 * configured Vercel environment must be one of Vercel's documented values;
 * blank or misspelled values fail closed instead of silently skipping gates.
 */
export function productionEnvironmentRequired(env = process.env) {
  if (Object.hasOwn(env, "VERCEL_ENV")) {
    const value = env.VERCEL_ENV;
    if (!VERCEL_ENVIRONMENTS.has(value)) {
      throw new Error(
        "VERCEL_ENV must be exactly production, preview, or development when configured",
      );
    }
    return value === "production";
  }

  return env.NODE_ENV === "production";
}

/**
 * Decide whether a Preview build must attest its own database. Nothing
 * migrates Preview databases automatically, and a Preview running on one that
 * lacks committed migrations serves broken pages (2026-10-07: both leagues
 * ran three migrations behind for ten days). So a Vercel Preview with a real
 * database attests it read-only, like production; a Preview without one (only
 * the inert build URL) has nothing to attest.
 */
export function previewDatabaseAttestationRequired(env = process.env) {
  if (productionEnvironmentRequired(env) || env.VERCEL_ENV !== "preview") {
    return false;
  }
  const url = env.DIRECT_URL || env.DATABASE_URL;
  return Boolean(url) && url !== INERT_BUILD_DATABASE_URL;
}
