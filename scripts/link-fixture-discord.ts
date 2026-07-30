// Give the seeded signups fixture its four Discord-membership cohorts,
// matching scripts/discord-standin.mjs's suffix routing (02 member,
// 03 pending, 04 not-in-server, 05 Discord-down). Run after
// seed-signups-fixture.ts:
//
//   DATABASE_URL="file:$PWD/prisma/signups-fixture.db" \
//     npx tsx scripts/link-fixture-discord.ts
import { PrismaClient } from "@prisma/client";

const url = process.env.DATABASE_URL ?? "";
if (!url.includes("fixture")) {
  throw new Error(`Refusing to touch ${url} — pass a fixture DATABASE_URL`);
}
const prisma = new PrismaClient();

const links: Array<[string, string, string]> = [
  ["Player 2", "700000000000000002", "member2"],
  ["Player 3", "700000000000000003", "pending3"],
  ["Player 4", "700000000000000004", "gone4"],
  ["Player 5", "700000000000000005", "fuzzy5"],
  ["x", "700000000000000102", "adminx"], // the admin — a member (…02 suffix)
];

async function main() {
  for (const [name, discordId, discordName] of links) {
    const n = await prisma.user.updateMany({
      where: { name },
      data: { discordId, discordName },
    });
    console.log(name, "->", discordId, n.count === 1 ? "ok" : "NOT FOUND");
  }
}
main().finally(() => prisma.$disconnect());
