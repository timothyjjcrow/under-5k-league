import type { PostflightResult } from "./migration-postflight.mjs";

export function postgresUrlForSchema(raw: string, schema: string): string;
export function parseRestoreArguments(args: string[]): {
  backupArgument: string;
  legacyBaseline: boolean;
};
export function deployRestoredMigrations(options?: {
  env?: NodeJS.ProcessEnv;
  runner?: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      encoding: "utf8";
    },
  ) => { status: number | null; stdout?: string; stderr?: string };
}): string;

export function rehearseBackupRestore(options?: {
  backupArgument?: string;
  restoreUrl?: string;
  env?: NodeJS.ProcessEnv;
  legacyBaseline?: boolean;
  baselineResolver?: (options: {
    env: NodeJS.ProcessEnv;
    confirmed: boolean;
  }) => Promise<string>;
  migrationPreflight?: (env: NodeJS.ProcessEnv) => string;
  migrateDeploy?: (options: { env: NodeJS.ProcessEnv }) =>
    | string
    | Promise<string>;
  postflight?: (options: {
    env: NodeJS.ProcessEnv;
  }) => Promise<PostflightResult>;
}): Promise<{
  applicationSchema: string;
  migrationCount: number;
  coreTableCount: number;
  attestation: PostflightResult;
  legacyBaseline: boolean;
}>;
