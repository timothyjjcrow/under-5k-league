// One-shot: make ADMIN_STEAM_IDS the EXACT set of admins in the database.
// Promotes every listed SteamID64 to ADMIN and demotes every other admin to
// USER. Run this once (e.g. against production) after setting ADMIN_STEAM_IDS to
// immediately reconcile existing accounts — logins keep it enforced afterwards.
//
//   ADMIN_STEAM_IDS="7656119…" DATABASE_URL="…" npm run set-admins
import { PrismaClient } from "@prisma/client";
import { parseAdminSteamIds } from "../src/lib/users";

const prisma = new PrismaClient();

async function main() {
  const ids = parseAdminSteamIds(process.env.ADMIN_STEAM_IDS);
  if (ids.length === 0) {
    console.error(
      "Set ADMIN_STEAM_IDS first, e.g. ADMIN_STEAM_IDS=\"7656119…\" npm run set-admins",
    );
    process.exit(1);
  }

  const promoted = await prisma.user.updateMany({
    where: { steamId: { in: ids }, role: { not: "ADMIN" } },
    data: { role: "ADMIN" },
  });
  const demoted = await prisma.user.updateMany({
    where: { steamId: { notIn: ids }, role: "ADMIN" },
    data: { role: "USER" },
  });

  const admins = await prisma.user.findMany({
    where: { role: "ADMIN" },
    select: { name: true, steamId: true },
  });
  const missing = ids.filter((id) => !admins.some((a) => a.steamId === id));

  console.log(
    `Reconciled admins to ${ids.length} SteamID(s): promoted ${promoted.count}, demoted ${demoted.count}.`,
  );
  console.log("Current admins:", admins);
  if (missing.length > 0) {
    console.log(
      "Note: these SteamIDs aren't in the DB yet (they'll become admin on first login):",
      missing,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
