import { Suspense } from "react";
import { prisma } from "@/lib/prisma";
import { SEASON_STATUS } from "@/lib/constants";
import { rollCallPhase } from "@/lib/roll-call";
import { fixturesMatchNightLabel } from "@/lib/match-night";
import { parseNextSeasonPlan } from "@/lib/next-season";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { CardSkeleton } from "@/components/ui";
import { loadAdminContext } from "@/components/admin/admin-context";
import { AdminFrame, AdminGateScreen } from "@/components/admin/admin-frame";
import { SeasonSettings } from "@/components/admin/season-settings";
import { SeasonFormatSetup } from "@/components/admin/season-format-setup";
import { DraftControls } from "@/components/admin/draft-controls";
import { AdminRollCall } from "@/components/admin/roll-call-section";
import { AdminMatchNightPoll } from "@/components/admin/match-night-poll-section";
import { LeagueControls } from "@/components/admin/league-controls";
import { OpenNextSeason } from "@/components/admin/open-next-season";
import { SeasonHandoffLocked } from "@/components/admin/season-handoff-locked";

export const metadata = { title: "Season · Admin" };

// See /admin: Server Actions inherit this segment's function budget.
export const maxDuration = 60;

/**
 * Season: setting the season up and handing it over, in the order it
 * happens. Its settings (read first, each with its own Edit), the league
 * ticket, the season builder (while captains are picked, folded once
 * saved), the Draft, the roll call (signups and the draft), the match night
 * poll, then the handoff, which is the only card here in the offseason.
 * Teams and signups are on People.
 */
export default async function AdminSeasonPage() {
  const ctx = await loadAdminContext();
  if (ctx.gate !== "admin") return <AdminGateScreen gate={ctx.gate} path="/admin/season" />;
  const { season, data, nowMs, handoffReadiness } = ctx;
  // Between seasons the job here is opening the next one: once a champion
  // is crowned, and in the offseason. A Complete season WITHOUT a valid
  // champion is a recovery state, so its handoff stays locked.
  const handoffOpen = !season || handoffReadiness?.ready === true;
  // The season a new one follows: the active one, or from the offseason the
  // most recent (createSeason carries its settings the same way).
  const newSeasonDefaults =
    season ??
    (await prisma.season.findFirst({
      where: { isActive: false },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }));
  const championName = handoffReadiness?.ready
    ? (data?.teams.find((team) => team.id === handoffReadiness.championTeamId)
        ?.name ?? null)
    : null;
  // The next season's signup date Home prints, set on the handoff card.
  const nextSeasonPlan =
    season?.status === SEASON_STATUS.COMPLETE && handoffReadiness?.ready
      ? parseNextSeasonPlan(await getSetting(SETTING_KEYS.NEXT_SEASON_PLAN), season.id)
      : null;
  return (
    <AdminFrame tab="season" counts={ctx.tabCounts}>
      {season && data ? <SeasonSettings season={season} data={data} /> : null}
      {season ? <LeagueControls season={season} /> : null}
      {season && data && ctx.formatCard ? (
        <SeasonFormatSetup season={season} data={data} nowMs={nowMs} />
      ) : null}
      {season && data ? <DraftControls season={season} data={data} /> : null}
      {season && rollCallPhase(season.status) ? (
        <Suspense fallback={<CardSkeleton rows={3} />}>
          <AdminRollCall />
        </Suspense>
      ) : null}
      {/* Season-independent, like news: a league polls for its night between
          seasons as often as during one. */}
      <Suspense fallback={<CardSkeleton rows={3} />}>
        <AdminMatchNightPoll
          admin={ctx.user}
          season={season}
          fixturesNight={data ? fixturesMatchNightLabel(data.matches) : null}
        />
      </Suspense>
      {handoffOpen ? (
        <OpenNextSeason
          season={season}
          previous={newSeasonDefaults}
          championName={championName}
          nextSignupsAtMs={nextSeasonPlan?.signupsAtMs ?? null}
        />
      ) : season && handoffReadiness ? (
        <SeasonHandoffLocked season={season} reason={handoffReadiness.reason} />
      ) : null}
    </AdminFrame>
  );
}
