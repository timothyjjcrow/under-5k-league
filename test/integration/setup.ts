import { beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetInhouseRoomPollForTests } from "@/lib/inhouse-room-memo";
import { resetInhouseRoomCacheForTests } from "@/lib/inhouse-room-cache";
import { resetLobbyBotStatusCacheForTests } from "@/lib/lobby-bot-status-cache";
import { settleInhouseBotReleases } from "@/lib/lobby-bot-releases";
import { resetInhouseRoomWaitersForTests } from "@/lib/inhouse-room-wait";
import { resetDraftRoomWaitersForTests } from "@/lib/draft-room-wait";
import { ensureSqlitePartialUniqueIndexes, resetDb } from "./factories";

// Every integration test starts from an empty database.
beforeEach(async () => {
  // A bot release a closing action started in the last test must not land
  // in this one's database or stubs. Files that stub the bot also settle
  // releases in their own afterEach, before they unstub fetch.
  await settleInhouseBotReleases();
  await resetDb();
  await ensureSqlitePartialUniqueIndexes();
  // The room poll's per-process board memo would otherwise carry one test's
  // board checks into the next.
  resetInhouseRoomPollForTests();
  // …and its room snapshot, labelled with a version the reset just deleted.
  resetInhouseRoomCacheForTests();
  // The bot status cache would serve one test's stubbed bot to the next.
  resetLobbyBotStatusCacheForTests();
  // …and any long-poll a test left held, with its timers (the draft room's
  // snapshot is a room cache too, reset above).
  resetInhouseRoomWaitersForTests();
  resetDraftRoomWaitersForTests();
});

afterAll(async () => {
  await prisma.$disconnect();
});
