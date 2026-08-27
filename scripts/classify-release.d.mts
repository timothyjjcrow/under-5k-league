export interface ReleaseDiffEntry {
  status: string;
  code: string;
  oldPath: string | null;
  path: string;
  oldMode?: string;
  newMode?: string;
  presentationSafe?: boolean;
}

export interface ReleaseClassification {
  lane: "ui-only" | "app" | "strict";
  changedFiles: string[];
  reasons: string[];
  needs_postgres: boolean;
  needs_mutation: boolean;
  needs_e2e: boolean;
  needs_db_release: boolean;
  needs_scheduler_pause: boolean;
}

export function parseNameStatus(output: string): ReleaseDiffEntry[];
export function parseRawDiff(output: string): ReleaseDiffEntry[];
export function isStaticClassNameOnlyDiff(patch: string): boolean;
export function classifyEntries(
  entries: ReleaseDiffEntry[],
): ReleaseClassification;
export function classifyRelease(options: {
  base: string;
  head: string;
  cwd?: string;
}): ReleaseClassification & { baseSha: string; headSha: string };
