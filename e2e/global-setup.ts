import { execSync } from "node:child_process";

// Reset the database to a known seeded state before the e2e run.
export default async function globalSetup() {
  execSync("npm run db:seed", { stdio: "inherit" });
}
