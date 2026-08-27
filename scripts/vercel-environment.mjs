const VERCEL_ENVIRONMENTS = new Set([
  "production",
  "preview",
  "development",
]);

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
