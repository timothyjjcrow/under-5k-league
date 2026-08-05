export const EXPECTED_BASELINE_FINGERPRINT: string;

export function inspectBaselineDatabase(options?: {
  env?: NodeJS.ProcessEnv;
}): Promise<{ actualFingerprint: string }>;
