import { cache } from "react";
import { prisma } from "./prisma";
import { SETTING_KEYS } from "./settings";

/** One fresh read per React render, shared by layout and public game readers.
 * Never persist-cache the revision: a post-correction reader must not join an
 * older refresh, including one still running on another server instance. */
export const getPublicReadSignals = cache(async function getPublicReadSignals() {
  const rows = await prisma.setting.findMany({
    where: { key: { in: [SETTING_KEYS.RESULT_CHANGED_AT, SETTING_KEYS.PUBLIC_GAME_REVISION] } },
    select: { key: true, value: true },
  });
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return {
    resultChangedAt: values.get(SETTING_KEYS.RESULT_CHANGED_AT) ?? null,
    publicGameRevision: values.get(SETTING_KEYS.PUBLIC_GAME_REVISION) ?? "legacy",
  };
});
