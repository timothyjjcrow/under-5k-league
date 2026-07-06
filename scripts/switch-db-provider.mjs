// Swap the Prisma datasource between sqlite (local dev/tests) and postgresql
// (production on Vercel + Neon). The committed schema stays on sqlite; Vercel's
// build runs this with "postgresql" so nothing local has to change.
//
//   node scripts/switch-db-provider.mjs postgresql
//   node scripts/switch-db-provider.mjs sqlite
import { readFileSync, writeFileSync } from "node:fs";

const target = process.argv[2];
if (!["sqlite", "postgresql"].includes(target)) {
  console.error("Usage: node scripts/switch-db-provider.mjs <sqlite|postgresql>");
  process.exit(1);
}

const path = new URL("../prisma/schema.prisma", import.meta.url);
const src = readFileSync(path, "utf8");

const block =
  target === "postgresql"
    ? [
        "datasource db {",
        '  provider  = "postgresql"',
        '  url       = env("DATABASE_URL")',
        '  directUrl = env("DIRECT_URL")',
        "}",
      ].join("\n")
    : [
        "datasource db {",
        '  provider = "sqlite"',
        '  url      = env("DATABASE_URL")',
        "}",
      ].join("\n");

const next = src.replace(/datasource db \{[\s\S]*?\n\}/, block);
if (next === src && !src.includes(block)) {
  console.error("Could not find the `datasource db { … }` block in schema.prisma");
  process.exit(1);
}
writeFileSync(path, next);
console.log(`schema.prisma datasource → ${target}`);
