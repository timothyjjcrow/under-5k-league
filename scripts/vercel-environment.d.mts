export const INERT_BUILD_DATABASE_URL: string;

export function productionEnvironmentRequired(
  env?: NodeJS.ProcessEnv,
): boolean;

export function previewDatabaseAttestationRequired(
  env?: NodeJS.ProcessEnv,
): boolean;
