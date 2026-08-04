import type { PostflightResult } from "./migration-postflight.mjs";

export function postgresUrlForSchema(raw: string, schema: string): string;

export function rehearseBackupRestore(options?: {
  backupArgument?: string;
  restoreUrl?: string;
  env?: NodeJS.ProcessEnv;
  postflight?: (options: {
    env: NodeJS.ProcessEnv;
  }) => Promise<PostflightResult>;
}): Promise<{
  applicationSchema: string;
  migrationCount: number;
  coreTableCount: number;
  attestation: PostflightResult;
}>;
