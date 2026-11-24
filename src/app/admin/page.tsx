import { webAnalyticsUrl } from "@/lib/web-analytics";
import { siteAnalyticsEnabled } from "@/lib/site-analytics";
import { adminSeasonCards, openBookingCount } from "@/lib/admin-sections";
import { Suspense } from "react";
import { SectionNav } from "@/components/section-nav";
import { redirect } from "next/navigation";
import Link from "@/components/app-link";
import { getSessionUser } from "@/lib/auth";
import { completedSeasonArchiveReadiness, getActiveSeason } from "@/lib/season";
import { rollCallPhase } from "@/lib/roll-call";
import { prisma } from "@/lib/prisma";
import { DRAFT_STATUS, MATCH_PHASE, SEASON_STATUS } from "@/lib/constants";
import { ImportProgress } from "@/components/import-progress";
import { DatabaseHealth } from "@/components/database-health";
import { HistoryCoverage } from "@/components/history-coverage";
import { archiveIncompleteSeasonAction } from "@/app/actions/admin-season";
import { parseNextSeasonPlan } from "@/lib/next-season";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { loadLeagueDeliveryHealth } from "@/lib/league-announcement-outbox";
import { MEDAL_APPROVALS_ANCHOR } from "@/lib/medal-approval";
import { matchNightSlate } from "@/lib/admin-match-night";
import { fixturesMatchNightLabel } from "@/lib/match-night";
import { projectPlayoffField } from "@/lib/playoff-field";
import { regularSeasonStatus } from "@/lib/schedule-status";
import { RevealHashTarget } from "@/components/reveal-hash-target";
import { ADMIN_MATCH_ROW_PREFIX } from "@/lib/match-anchors";
import { ActionForm, SubmitButton } from "@/components/action-form";
import {
  CardBody,
  CardSkeleton,
  EmptyState,
  PageTitle,
  buttonClasses,
  textLink,
} from "@/components/ui";
import { AdminActivity } from "@/components/admin/admin-activity";
import { AdminAnchor, AdminSection } from "@/components/admin/admin-section";
import { AutoSyncHealth } from "@/components/admin/auto-sync-health";
import {
  AutomationRunnerHealth,
  loadAutomationAttention,
} from "@/components/admin/automation-runner";
import { CaptainControls } from "@/components/admin/captain-controls";
import { DiscordSection } from "@/components/admin/discord-controls";
import { DiscordReachCard } from "@/components/admin/discord-reach-card";
import { AdminInhouseNight } from "@/components/admin/inhouse-night-section";
import { LeagueControls } from "@/components/admin/league-controls";
import { AdminMatchNightPoll } from "@/components/admin/match-night-poll-section";
import { MedalApprovalsSection } from "@/components/admin/medal-approvals-section";
import { AdminAttention } from "@/components/admin/needs-attention-card";
import { AdminNews } from "@/components/admin/news-controls";
import {
  NextStepBanner,
  adminNextStepFor,
} from "@/components/admin/next-step-banner";
import { OpenNextSeason } from "@/components/admin/open-next-season";
import { PlayoffControls } from "@/components/admin/playoff-controls";
import { AdminRollCall } from "@/components/admin/roll-call-section";
import { RosterMoves } from "@/components/admin/roster-moves";
import { ScheduleControls } from "@/components/admin/schedule-controls";
import { loadSeasonAdminData } from "@/components/admin/season-admin-data";
import {
  autoSyncVisible,
  formatBuilderAnchor,
  rosterMovesVisible,
  unlinkedRosterFor,
} from "@/components/admin/season-admin-rules";
import { SeasonControls } from "@/components/admin/season-controls";
import { SeasonFormatSetup } from "@/components/admin/season-format-setup";
import { SecurityControls } from "@/components/admin/security-controls";
import { StandinControls } from "@/components/admin/standin-controls";
import { StreamControls } from "@/components/admin/stream-controls";
import { TiebreakerControls } from "@/components/admin/tiebreaker-controls";
import { TonightMatches } from "@/components/admin/tonight-matches";

export const metadata = { title: "Admin" };

// Server Actions invoked from this page inherit the segment's function budget.
// The bulk OpenDota syncs (ranks, league) fan out network calls that can each
// hit an 8s timeout, so give them headroom above the platform default rather
// than being killed mid-run (which leaves the button spinning "Working…").
// 60s is the Hobby-plan ceiling; the actions themselves stop well before it.
export const maxDuration = 60;

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ newsPage?: string | string[]; importPage?: string | string[] }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/admin");
  if (user.role !== "ADMIN") {
    return (
      <div className="space-y-8">
        <PageTitle
          title="Admin access required"
          subtitle="This area is limited to league administrators."
        />
        <EmptyState
          title="You do not have administrator access"
          description="Your account is signed in, but it is not on the administrator allowlist. Ask a league administrator if you believe this is a mistake."
          action={
            <Link href="/" className={buttonClasses("secondary")}>
              Return to league home
            </Link>
          }
        />
      </div>
    );
  }

  const season = await getActiveSeason();

  // Delivery health is database-only, so it can sit on the blocking path.
  const [data, delivery] = await Promise.all([
    season ? loadSeasonAdminData(season.id, season.teamSize) : null,
    season ? loadLeagueDeliveryHealth().catch(() => null) : null,
  ]);
  // Async server component: it renders once per request, so Date.now() has
  // no re-render to be inconsistent across. "Outstanding" means past kickoff.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const nextStep =
    season && data ? adminNextStepFor(season, data, nowMs) : null;
  const tonight =
    season && data ? matchNightSlate(season.status, data.matches, nowMs) : [];
  // DB-only and shared with the streamed runner card below.
  const automationLines = season && data ? await loadAutomationAttention() : [];
  const cards =
    season && data
      ? adminSeasonCards({
          seasonStatus: season.status,
          draftStatus: data.draft?.status,
          matches: data.matches,
          openBookings: openBookingCount(data.assignments, data.matches),
          archivedPostseasonGames:
            data.playoffArchive.length + data.tiebreakerArchive.length,
        })
      : null;
  const showTiebreakers = season != null && data != null && (
    data.matches.some((match) => match.phase === MATCH_PHASE.TIEBREAKER) ||
    (regularSeasonStatus(data.matches).allComplete &&
      projectPlayoffField(data.teams, data.matches, season).tiebreakers.groups.length > 0)
  );
  const handoffReadiness =
    season && data
      ? completedSeasonArchiveReadiness(
          season,
          data.matches,
          data.teams.map((team) => team.id),
        )
      : null;
  // The season a new one follows: the active one, or from the offseason the
  // most recent (createSeason carries its settings the same way).
  const newSeasonDefaults =
    season ??
    (await prisma.season.findFirst({
      where: { isActive: false },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }));

  // During signups and the draft phase, setting up the season is the job:
  // the phase and captains cards and the Discord reach card come first. Once
  // the auction is complete the job is the schedule, and the captains card
  // (which lists every signup) used to sit between the admin and Generate
  // schedule on draft night.
  const auctionDone =
    season?.status === "DRAFT" && data?.draft?.status === DRAFT_STATUS.COMPLETE;
  const setupFirst =
    season?.status === "SIGNUPS" || (season?.status === "DRAFT" && !auctionDone);
  const seasonCard = season && data && nextStep ? (
    <AdminAnchor id="adm-season">
      <SeasonControls season={season} data={data} nextStep={nextStep} />
    </AdminAnchor>
  ) : null;
  const captainsCard = season && data && nextStep ? (
    <AdminAnchor id="adm-captains">
      <CaptainControls season={season} data={data} nowMs={nowMs} />
    </AdminAnchor>
  ) : null;
  const setupControls = seasonCard ? <>{seasonCard}{captainsCard}</> : null;
  // While captains are picked the layout is chosen beside them. Once the
  // schedule card shows (after the auction, or fixtures from a phase
  // recovery) the builder lives there instead, so there is only ever one.
  const formatSetupCard =
    season && data && formatBuilderAnchor(season, data) === "#adm-format" ? (
      <AdminAnchor id="adm-format">
        <SeasonFormatSetup season={season} data={data} nowMs={nowMs} />
      </AdminAnchor>
    ) : null;
  // Between seasons the job left on this page is opening the next one, so
  // its card leads, right under the title: once a champion is crowned, and
  // in the offseason. A crowned season's own cards can no longer change much,
  // so they fold into one "<season> record" section instead of standing
  // between the admin and the handoff. A Complete season WITHOUT a valid
  // champion is a recovery state: its cards stay open and the locked handoff
  // stays last.
  const handoffFirst = !season || handoffReadiness?.ready === true;
  const seasonRecord = season && data && handoffReadiness?.ready ? season : null;
  const championName = handoffReadiness?.ready
    ? (data?.teams.find((team) => team.id === handoffReadiness.championTeamId)
        ?.name ?? null)
    : null;
  // The next season's signup date Home prints, set on the handoff card.
  const nextSeasonPlan =
    season?.status === SEASON_STATUS.COMPLETE && handoffReadiness?.ready
      ? parseNextSeasonPlan(
          await getSetting(SETTING_KEYS.NEXT_SEASON_PLAN),
          season.id,
        )
      : null;
  const importQuery = await searchParams;
  // Chasing Discord links is a weekly people task, so it sits beside the
  // signups (before the draft) or the rosters (after it), not inside the
  // collapsed Discord settings. Streamed: its membership sweep calls Discord.
  const reachCard = season ? (
    <AdminAnchor id="adm-reach">
      <Suspense fallback={<CardSkeleton rows={3} />}>
        <DiscordReachCard
          seasonId={season.id}
          rosterUnlinked={data ? unlinkedRosterFor(season, data) : null}
          signupsSeasonName={season.status === "SIGNUPS" ? season.name : null}
        />
      </Suspense>
    </AdminAnchor>
  ) : null;
  // The roll call runs during signups and the draft, and follows the reach
  // card wherever that renders: both are about whether players will show.
  const rollCallCard =
    season && rollCallPhase(season.status) ? (
      <Suspense fallback={<CardSkeleton rows={3} />}>
        <AdminRollCall />
      </Suspense>
    ) : null;
  // The auto-sync card and the import review are spaced like every other
  // card, and the anchor hides when neither has anything to show (outside
  // the regular season and playoffs, with no import waiting) so it adds no
  // gap. Database performance is its own folded section after them: inside
  // the anchor, a jump to Auto-sync would unfold it too.
  const syncCards = season ? (
    <>
      <AdminAnchor id="adm-sync" className="space-y-5 empty:hidden">
        <AutoSyncHealth season={season} />
        <Suspense fallback={<CardSkeleton rows={3} />}>
          <ImportProgress seasonId={season.id} page={importQuery.importPage} query={importQuery} />
        </Suspense>
      </AdminAnchor>
      <AdminSection
        title="Database performance"
        subtitle="Connection waits, busy connections and timeouts on this server instance."
      >
        <Suspense fallback={<CardSkeleton rows={3} />}>
          <DatabaseHealth />
        </Suspense>
      </AdminSection>
    </>
  ) : null;

  // The chips follow the page's order, so the active chip only ever moves
  // forward as the admin scrolls down: with setupFirst the phase, captains
  // and Discord reach chips lead, as their cards do; later they follow the
  // season's working cards.
  const setupItems = [
    { id: "adm-season", label: "Phase" },
    ...(formatSetupCard ? [{ id: "adm-format", label: "Season format" }] : []),
    { id: "adm-captains", label: "Captains & draft" },
  ];
  const reachItem = { id: "adm-reach", label: "Discord reach" };
  // Its chip follows the reach chip, as its card follows the reach card.
  const rollCallItems =
    season && rollCallPhase(season.status)
      ? [{ id: "adm-roll-call", label: "Roll call" }]
      : [];
  const jumpItems: { id: string; label: string }[] = [
    ...(handoffFirst
      ? [
          {
            id: "adm-new-season",
            label: season ? "Season handoff" : "Open a new season",
          },
        ]
      : []),
    ...(season && data && seasonRecord
      ? [
          { id: "adm-attention", label: "Needs attention" },
          { id: "adm-record", label: "Season record" },
          { id: "adm-league", label: "League id" },
        ]
      : season && data
      ? [
          ...(tonight.length > 0
            ? [{ id: "adm-tonight", label: "Tonight" }]
            : []),
          { id: "adm-attention", label: "Needs attention" },
          ...(showTiebreakers ? [{ id: "adm-tiebreakers", label: "Tiebreakers" }] : []),
          ...(setupFirst ? [...setupItems, reachItem, ...rollCallItems] : []),
          ...(cards?.schedule
            ? [{ id: "adm-schedule", label: "Schedule & results" }]
            : []),
          ...(cards?.playoffs ? [{ id: "adm-playoffs", label: "Playoffs" }] : []),
          ...(rosterMovesVisible(season, data)
            ? [{ id: "adm-roster", label: "Roster moves" }]
            : []),
          ...(cards?.standins
            ? [{ id: "adm-standins", label: "Standins" }]
            : []),
          ...(setupFirst ? [] : [reachItem, ...rollCallItems]),
          ...(autoSyncVisible(season)
            ? [{ id: "adm-sync", label: "Auto-sync" }]
            : []),
          ...(setupFirst ? [] : setupItems),
          { id: "adm-league", label: "League id" },
        ]
      : []),
    { id: "adm-stream", label: "Match stream" },
    { id: "adm-history", label: "Historical records" },
    { id: "adm-automation", label: "Automation" },
    // Season-independent: inhouse alerts and the queue board are most
    // important in the offseason, when inhouse is the live mode.
    { id: "adm-inhouse-night", label: "Inhouse night" },
    { id: "adm-inhouse-players", label: "Inhouse players" },
    // Season-independent too: an approval covers the league and inhouses.
    { id: MEDAL_APPROVALS_ANCHOR, label: "Medal approvals" },
    { id: "adm-discord", label: "Discord" },
    { id: "adm-activity", label: "Activity" },
    { id: "adm-poll", label: "Match night poll" },
    { id: "adm-news", label: "News" },
    { id: "adm-security", label: "Security" },
    ...(handoffFirst
      ? []
      : [{ id: "adm-new-season", label: "Season handoff" }]),
  ];

  return (
    // 20px between cards (was 32): about twenty cards stack here.
    <div className="space-y-5">
      <PageTitle
        title="Admin"
        subtitle="Run the league — create seasons, pick captains, run the draft, enter results."
      />

      {nextStep ? <NextStepBanner nextStep={nextStep} /> : null}

      <AdminJump items={jumpItems} />

      {handoffFirst ? (
        <OpenNextSeason
          season={season}
          previous={newSeasonDefaults}
          championName={championName}
          nextSignupsAtMs={nextSeasonPlan?.signupsAtMs ?? null}
        />
      ) : null}

      {season && data && seasonRecord ? (
        <>
          <AdminAttention
            season={season}
            data={data}
            delivery={delivery}
            automation={automationLines}
            jumpItems={jumpItems}
          />
          {/* The match page's "Open this match in the admin panel" link lands
              on a result row, often inside a folded week or the folded season
              record. */}
          <RevealHashTarget prefix={ADMIN_MATCH_ROW_PREFIX} />
          <AdminSection
            id="adm-record"
            title={`${seasonRecord.name} record`}
            subtitle="Schedule and results, playoffs, standins, phase and draft settings for the finished season. Correct the grand final or reset the playoffs here."
            headingLevel={2}
          >
            <div className="space-y-6 p-3 sm:p-4">
              {showTiebreakers ? (
                <AdminAnchor id="adm-tiebreakers">
                  <TiebreakerControls season={season} data={data} nowMs={nowMs} />
                </AdminAnchor>
              ) : null}
              {cards?.schedule ? (
                <AdminAnchor id="adm-schedule">
                  <ScheduleControls
                    season={season}
                    data={data}
                    nowMs={nowMs}
                  />
                </AdminAnchor>
              ) : null}
              {cards?.playoffs ? (
                <AdminAnchor id="adm-playoffs">
                  <PlayoffControls season={season} data={data} nowMs={nowMs} />
                </AdminAnchor>
              ) : null}
              <AdminAnchor id="adm-roster">
                <RosterMoves season={season} data={data} />
              </AdminAnchor>
              {cards?.standins ? (
                <AdminAnchor id="adm-standins">
                  <StandinControls
                    season={season}
                    data={data}
                    viewerId={user.id}
                  />
                </AdminAnchor>
              ) : null}
              {setupControls}
            </div>
          </AdminSection>
          {syncCards}
          <LeagueControls season={season} />
        </>
      ) : season && data ? (
        <>
          {tonight.length > 0 ? (
            <TonightMatches
              season={season}
              data={data}
              slate={tonight}
              nowMs={nowMs}
            />
          ) : null}
          <AdminAttention
            season={season}
            data={data}
            delivery={delivery}
            automation={automationLines}
            jumpItems={jumpItems}
          />
          {/* The match page's "Open this match in the admin panel" link lands
              on a result row, often inside a folded week or the folded season
              record. */}
          <RevealHashTarget prefix={ADMIN_MATCH_ROW_PREFIX} />
          {showTiebreakers ? (
            <AdminAnchor id="adm-tiebreakers">
              <TiebreakerControls season={season} data={data} nowMs={nowMs} />
            </AdminAnchor>
          ) : null}
          {setupFirst ? (
            <>
              {seasonCard}
              {formatSetupCard}
              {captainsCard}
              {reachCard}
              {rollCallCard}
            </>
          ) : null}
          {/* Each card only where it has work or data (adminSeasonCards):
              the same answer the jump bar above was built from. */}
          {cards?.schedule ? (
            <AdminAnchor id="adm-schedule">
              <ScheduleControls
                season={season}
                data={data}
                nowMs={nowMs}
              />
            </AdminAnchor>
          ) : null}
          {cards?.playoffs ? (
            <AdminAnchor id="adm-playoffs">
              <PlayoffControls season={season} data={data} nowMs={nowMs} />
            </AdminAnchor>
          ) : null}
          <AdminAnchor id="adm-roster">
            <RosterMoves season={season} data={data} />
          </AdminAnchor>
          {cards?.standins ? (
            <AdminAnchor id="adm-standins">
              <StandinControls
                season={season}
                data={data}
                viewerId={user.id}
              />
            </AdminAnchor>
          ) : null}
          {setupFirst ? null : reachCard}
          {setupFirst ? null : rollCallCard}
          {syncCards}
          {setupFirst ? null : setupControls}
          <LeagueControls season={season} />
        </>
      ) : null}

      {/* League-wide, like everything below: the stream link outlives the
          season and needs no active one. */}
      <AdminAnchor id="adm-stream">
        <Suspense fallback={<CardSkeleton rows={2} />}>
          <StreamControls />
        </Suspense>
      </AdminAnchor>

      <AdminAnchor id="adm-history">
        <AdminSection
          title="Historical records"
          subtitle="How many imported games are indexed and how much roster history is kept, with the tools to fill gaps."
        >
          <Suspense fallback={<CardSkeleton rows={3} />}>
            <HistoryCoverage />
          </Suspense>
        </AdminSection>
      </AdminAnchor>

      {/* Evergreen: cron also owns offseason/inhouse maintenance, and an
          absent active season must never hide the only production scheduler
          health surface. The query is isolated so an unavailable health table
          does not take the rest of the admin panel down with it. */}
      <AdminAnchor id="adm-automation">
        <Suspense fallback={<CardSkeleton rows={5} />}>
          <AutomationRunnerHealth />
        </Suspense>
      </AdminAnchor>

      {/* The planned inhouse night: season-independent like inhouse itself.
          Streamed: its Discord interested count must never hold up the page. */}
      <Suspense fallback={<CardSkeleton rows={2} />}>
        <AdminInhouseNight />
      </Suspense>

      {/* Any player's inhouse MMR and medal, signed up for the league or not:
          a page of its own, since it lists and searches every player. */}
      <AdminSection
        id="adm-inhouse-players"
        title="Inhouse players"
        subtitle="Set any player's inhouse MMR and medal, signed up for the league or not, and ban players from inhouse games."
      >
        <CardBody className="space-y-3">
          <p className="text-sm text-muted">
            Every inhouse join uses an MMR set there, over the player&apos;s
            league signup&apos;s and anything they type. The medal is the one
            shown across the site. Inhouse bans are made and lifted there
            too, with the Discord role a banned player gets.
          </p>
          <Link
            href="/admin/inhouse-players"
            className={buttonClasses("secondary", "sm")}
          >
            Open inhouse players
          </Link>
        </CardBody>
      </AdminSection>

      {/* Players over the medal line asking to be let in: season-independent,
          since an approval covers inhouses too. Streamed like the night. */}
      <Suspense fallback={<CardSkeleton rows={2} />}>
        <MedalApprovalsSection />
      </Suspense>

      {/* Evergreen because its inhouse channel, ping role and live board do
          not belong to a season; every inhouse control stays usable in the
          offseason. Streamed: Discord health has bounded network calls and
          must never hold up the rest of the admin page. */}
      <Suspense fallback={<CardSkeleton rows={6} />}>
        <DiscordSection />
      </Suspense>

      <div>
        <Suspense fallback={<CardSkeleton rows={4} />}>
          <AdminActivity />
        </Suspense>
      </div>

      {/* Season-independent, like news: a league polls for its night between
          seasons as often as during one. */}
      <Suspense fallback={<CardSkeleton rows={3} />}>
        <AdminMatchNightPoll
          admin={user}
          season={season}
          fixturesNight={data ? fixturesMatchNightLabel(data.matches) : null}
        />
      </Suspense>

      <Suspense fallback={<CardSkeleton rows={4} />}><AdminNews searchParams={searchParams} /></Suspense>

      <SecurityControls />

      {season && handoffReadiness && !handoffReadiness.ready ? (
        <AdminSection
          id="adm-new-season"
          title="Season handoff"
          subtitle="The normal handoff unlocks after an authoritative champion is crowned."
        >
          <CardBody className="space-y-3">
            <div className="rounded-lg border border-accent/40 bg-accent/10 px-4 py-3 text-sm">
              <div className="font-medium text-fg">Handoff locked</div>
              <p className="mt-1 text-muted">{handoffReadiness.reason}</p>
              <p className="mt-1 text-muted">
                No data has to be discarded to continue the league. Use the
                phase, result, or playoff recovery controls above first.
              </p>
            </div>
            {season.status !== SEASON_STATUS.COMPLETE ? (
              <details className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm">
                <summary className="cursor-pointer font-medium text-danger">
                  Need to cancel this unfinished season?
                </summary>
                <p className="mt-2 text-muted">
                  This is separate from a normal handoff. It closes every
                  active-season signup, draft, match, sync, and reminder
                  workflow immediately. Saved teams, signups, matches, and
                  games remain in History, and an admin can reactivate the
                  season later. If an auction is live, its lot and bids are
                  preserved with both clocks paused for an admin to review.
                </p>
                <ActionForm
                  action={archiveIncompleteSeasonAction}
                  hidden={{
                    expectedActiveSeasonId: season.id,
                    expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
                  }}
                  className="mt-3"
                >
                  <SubmitButton
                    variant="danger"
                    confirm={`Cancel and archive unfinished ${season.name}? Active league workflows stop immediately. Nothing is deleted; a live auction is paused, and reactivation remains available from Season history after you enter the offseason.`}
                  >
                    Cancel season and enter offseason
                  </SubmitButton>
                </ActionForm>
              </details>
            ) : null}
          </CardBody>
        </AdminSection>
      ) : null}

      {/* One outbound link, so a footer line rather than a card. Each league
          is its own Vercel project; the link follows this deployment's region.
          Only Vercel production counts traffic there: the self-hosted box
          reads Cloudflare's zone analytics, so it shows no link. */}
      {siteAnalyticsEnabled() ? (
        <p className="border-t border-line-soft pt-4 text-xs text-muted">
          Website traffic:{" "}
          <a
            href={webAnalyticsUrl(LEAGUE_CONFIG.region)}
            target="_blank"
            rel="noopener noreferrer"
            className={textLink()}
          >
            open {LEAGUE_CONFIG.name} in Vercel Web Analytics ↗
          </a>{" "}
          (needs access to the league&rsquo;s Vercel project; admin, account and
          sign-in pages aren&rsquo;t counted).
        </p>
      ) : null}
    </div>
  );
}

/**
 * The jump bar. From desktop width it is sticky under the 64px header
 * (`top-16`, the same offset the draft room's clock bar uses) so it stays
 * reachable however far down the page an admin has scrolled. On a phone it
 * scrolls away with the page like every section bar (see SectionNav): pinned,
 * it cost a fifth of the screen on top of the header and the tab bar.
 *
 * With up to twenty chips it can't fit one desktop row, and a desktop mouse
 * can't scroll sideways, so from `lg` it wraps (`wrap`): two rows at most
 * desktop widths, three near 1024px, about 135px at most. Every jump target
 * here therefore clears the header plus that bar at `lg` with
 * `lg:scroll-mt-56` (224px), beside the phone's `scroll-mt-40`.
 *
 * A jump opens the section and, inside it, only a folded AdminSection
 * (`data-section-jump`). Every other disclosure in a card (Fix the phase,
 * Fix the bracket, Assign any match, a news Edit form, the handoff's archive
 * option) stays as the page rendered it, so a jump to a card never unfolds
 * its danger controls or an edit form.
 */
function AdminJump({ items }: { items: { id: string; label: string }[] }) {
  return (
    <SectionNav
      items={items}
      label="Admin sections"
      sticky
      openNested="marked"
      wrap
    />
  );
}
