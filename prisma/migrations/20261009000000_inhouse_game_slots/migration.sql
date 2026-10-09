-- Two inhouse games can be live at once, each in a numbered slot. The slot
-- index replaces the one-live-lobby index: at most one live lobby per slot.
-- Every existing lobby takes slot 1, and the binary already serving keeps
-- forming one game at a time under its own Serializable check, so neither the
-- new column nor the dropped index changes anything it relies on. The drop is
-- the one reviewed contraction in scripts/migration-safety.mjs. A Dota match
-- can be recorded on only one lobby.

BEGIN;

-- AlterTable
ALTER TABLE "InhouseLobby" ADD COLUMN "slot" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE UNIQUE INDEX "InhouseLobby_live_slot_idx"
  ON "InhouseLobby" ("slot")
  WHERE "status" IN (
    'READY_CHECK',
    'CAPTAIN_VOTE',
    'DRAFTING',
    'READY',
    'IN_PROGRESS'
  );

DROP INDEX "InhouseLobby_one_active_idx";

-- CreateIndex
CREATE UNIQUE INDEX "InhouseLobby_dotaMatchId_key" ON "InhouseLobby"("dotaMatchId");

COMMIT;
