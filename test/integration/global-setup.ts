import { execSync } from "node:child_process";
import {
  prepareSqliteTestDatabase,
  sqliteTestDatabaseUrl,
} from "../../scripts/prepare-sqlite-test-db.mjs";

// Create the test database schema once before the integration run.
export default function globalSetup() {
  const url = sqliteTestDatabaseUrl("integration");
  prepareSqliteTestDatabase("integration", url);
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
}
