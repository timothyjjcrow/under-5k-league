export interface VercelBuildStep {
  id: string;
  executable: "node" | "npm";
  args: readonly string[];
}

export const VERCEL_BUILD_STEPS: readonly VercelBuildStep[];

export function vercelBuildEnvironment(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;

export function runVercelBuild(options?: {
  env?: NodeJS.ProcessEnv;
  execute?: typeof import("node:child_process").execFileSync;
}): void;
