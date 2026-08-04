export const PREFLIGHT_SQL: string;
export function runMigrationPreflight(
  env?: NodeJS.ProcessEnv,
  options?: { allowUnresolvedBaseline?: boolean },
): string;
