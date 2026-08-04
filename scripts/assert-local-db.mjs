// Refuse to let a destructive local command touch a non-local database.
//
// `npm run db:seed` deletes every row before inserting demo data,
// `npm run db:reset` runs `prisma db push --force-reset` first, which DROPS the
// schema, and an accidental `db:push` can mutate a remote schema. These commands
// must check where they are pointing. Meanwhile
// the README teaches the operator to put the PRODUCTION url on a command line
// (`DATABASE_URL="postgres://…" npm run db:backup`), so a shell-history recall
// is all it takes to wipe the live league with a zero exit code.
//
// The rule: a `file:` url (local SQLite) is fine; anything else needs an
// explicit, hard-to-typo opt-in. scripts/seed-fixture.ts already guards itself
// the same way — the destructive scripts need it more.
//
//   node scripts/assert-local-db.mjs            # exits 1 unless local/opted in
//   import { assertLocalDatabase } from "…"     # same check, throws-free exit
import { readFileSync } from "node:fs";
import path from "node:path";

export const OVERRIDE = "I_UNDERSTAND_THIS_WIPES_THE_DATABASE";

/** DATABASE_URL from the environment, falling back to .env like Prisma does. */
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const env = readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
    for (const line of env.split("\n")) {
      const m = line.match(/^\s*DATABASE_URL\s*=\s*"?([^"#]+?)"?\s*$/);
      if (m) return m[1];
    }
  } catch {
    // no .env — treated as unset, which is refused below
  }
  return "";
}

/**
 * Keep the refusal useful without ever echoing URL credentials or parameters.
 * A malformed value is still treated as configured, but none of it is printed.
 */
function sanitizedTarget(url) {
  if (!url) return "(unset)";
  try {
    const parsed = new URL(url);
    const host = parsed.hostname
      ? `//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`
      : "";
    return `${parsed.protocol}${host} (credentials, path, and parameters redacted)`;
  } catch {
    return "(set; value redacted)";
  }
}

/** Exit the process unless the target database is local (or explicitly waived). */
export function assertLocalDatabase(action = "This command") {
  if (process.env[OVERRIDE] === "1") return;
  const url = resolveUrl();
  if (url.startsWith("file:")) return;
  console.error(
    `\nRefusing to continue: DATABASE_URL is not a local SQLite file.\n` +
      `  DATABASE_URL = ${sanitizedTarget(url)}\n\n` +
      `${action} DESTROYS the data in that database. If you really mean to, re-run with:\n` +
      `  ${OVERRIDE}=1 <your command>\n`,
  );
  process.exit(1);
}

// Direct invocation (the `&&` guard at the front of an npm script).
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  assertLocalDatabase(process.argv[2] || "This command");
}
