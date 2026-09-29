-- Additive, nullable columns for the September 2026 review follow-ups. Every
-- existing row keeps working unchanged; an older application binary simply
-- never reads or writes these columns.
BEGIN;

ALTER TABLE "NewsPost" ADD COLUMN "discordMessageId" TEXT;

ALTER TABLE "LeagueAnnouncement" ADD COLUMN "expiresAt" TIMESTAMP(3);

ALTER TABLE "InhouseLobby" ADD COLUMN "endReason" TEXT;

COMMIT;
