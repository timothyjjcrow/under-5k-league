import { defineConfig } from "vitest/config";
import path from "node:path";

// Integration tests hit a real (SQLite) database — a dedicated test.db, kept
// separate from the dev/prod DBs. Run with `npm run test:integration`.
const testDbUrl = `file:${path.resolve(process.cwd(), "prisma/test.db")}`;

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(process.cwd(), "src") },
  },
  test: {
    environment: "node",
    include: ["test/integration/**/*.itest.ts"],
    globalSetup: ["./test/integration/global-setup.ts"],
    setupFiles: ["./test/integration/setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    env: { DATABASE_URL: testDbUrl, NODE_ENV: "test" },
  },
});
