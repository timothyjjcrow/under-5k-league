import { execSync } from "node:child_process";
import path from "node:path";

// Create the test database schema once before the integration run.
export default function globalSetup() {
  const url = `file:${path.resolve(process.cwd(), "prisma/test.db")}`;
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
}
