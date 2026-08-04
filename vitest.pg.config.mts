import { defineConfig } from "vitest/config";
import path from "node:path";
import { assertPostgresTestUrl } from "./scripts/test-db-safety.mjs";

// Same integration suite, pointed at a real POSTGRES database — the production
// engine. SQLite serializes writers, which masks the read-then-write races the
// mutation guards exist for; this config is how we verify them for real.
//   PG_TEST_URL="postgresql://…" npx vitest run --config vitest.pg.config.mts
// Requires the schema to already be on the postgresql provider + pushed
// (scripts/switch-db-provider.mjs postgresql && prisma db push).
const url = process.env.PG_TEST_URL;
assertPostgresTestUrl(url);

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(process.cwd(), "src") },
  },
  test: {
    environment: "node",
    include: ["test/integration/**/*.itest.ts"],
    setupFiles: ["./test/integration/setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    env: { DATABASE_URL: url, DIRECT_URL: url, NODE_ENV: "test" },
  },
});
