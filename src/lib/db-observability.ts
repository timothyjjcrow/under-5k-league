import { createDatabaseDiagnostics } from "./database-diagnostics";

// Share bounded process counters across server bundles and development reloads.
// No timers, retained queries, identifiers or request bodies are kept here.
const host = globalThis as typeof globalThis & {
  leagueDatabaseDiagnostics?: ReturnType<typeof createDatabaseDiagnostics>;
};
export const databaseDiagnostics = host.leagueDatabaseDiagnostics ??=
  createDatabaseDiagnostics([]);

export function readDatabaseDiagnostics() {
  return databaseDiagnostics.snapshot(Date.now());
}
