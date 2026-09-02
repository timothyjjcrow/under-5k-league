export interface PostflightMigration {
  name: string;
  checksum: string;
  finished: boolean;
  rolledBack: boolean;
}

export interface PostflightFunction {
  name: string;
  arguments: string;
  result: string;
  language: string;
  kind: string;
  volatility: string;
  securityDefiner: boolean;
  body: string;
}

export interface PostflightTrigger {
  name: string;
  table: string;
  functionName: string;
  functionSchema: string;
  timing: string;
  rowLevel: boolean;
  onInsert: boolean;
  onUpdate: boolean;
  onDelete: boolean;
  onTruncate: boolean;
  updateColumns: string[];
  argumentCount: number;
  whenExpression: string | null;
  oldTable: string | null;
  newTable: string | null;
  enabled: string;
}

export interface PostflightPartialIndex {
  name: string;
  table: string;
  unique: boolean;
  valid: boolean;
  ready: boolean;
  live: boolean;
  primary: boolean;
  accessMethod: string;
  expression: string | null;
  predicate: string | null;
  keyCount: number;
  attributeCount: number;
}

export interface PostflightCheck {
  name: string;
  table: string;
  definition: string;
  validated: boolean;
  noInherit: boolean;
}

export interface PostflightSnapshot {
  schema: string;
  migrations: PostflightMigration[];
  functions: PostflightFunction[];
  triggers: PostflightTrigger[];
  partialIndexes: PostflightPartialIndex[];
  checks: PostflightCheck[];
}

export interface PostflightResult {
  schema: string;
  migrationCount: number;
  nativeObjectCount: number;
}

export const EXPECTED_RELEASE_NATIVE: Readonly<{
  functions: Readonly<Record<string, Omit<PostflightFunction, "name">>>;
  triggers: Readonly<Record<string, Omit<PostflightTrigger, "name"> & { functionSchema: "current" }>>;
  partialIndexes: Readonly<Record<string, Omit<PostflightPartialIndex, "name">>>;
  checks: Readonly<Record<string, Omit<PostflightCheck, "name">>>;
}>;

export function normalizeSqlDefinition(value: string): string;
export function postgresDatamodel(source: string): string;
export function validatePostflightSnapshot(
  snapshot: PostflightSnapshot,
): PostflightResult;
export function inspectPostflightDatabase(options?: {
  env?: NodeJS.ProcessEnv;
}): Promise<PostflightResult>;
