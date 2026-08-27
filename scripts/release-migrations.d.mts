export interface MigrationReleaseStep {
  readonly id: string;
  readonly executable: "node" | "npm";
  readonly args: readonly string[];
}

export const MIGRATION_RELEASE_STEPS: readonly MigrationReleaseStep[];

export const PRISMA_DOTENV_PATHS: readonly {
  readonly label: string;
  readonly path: string;
}[];

export function authorizeMigrationRelease(input: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  headSha: string;
  status: string;
}): string;

export function assertNoPrismaDotenvFiles(
  fileExists?: (path: string) => boolean,
): void;

export function runMigrationRelease(options?: {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  execute?: (
    executable: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      stdio: "inherit";
    },
  ) => unknown;
}): string;
