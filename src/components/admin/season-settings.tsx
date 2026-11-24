import {
  setMaxMmr,
  setMatchSchedule,
  renameSeason,
  setSeriesLengths,
  setDraftSettings,
} from "@/app/actions/admin-season";
import { fixturesMatchNightLabel } from "@/lib/match-night";
import { draftSetupLockedMessage, draftSetupOpen } from "@/lib/draft-setup";
import {
  MATCH_SCHEDULE,
  HARD_MMR_CEILING,
  DRAFT_CLOCK_LIMITS,
} from "@/lib/constants";
import { ActionForm, SubmitButton } from "@/components/action-form";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  buttonClasses,
} from "@/components/ui";
import { Field, SeriesField } from "@/components/admin/admin-fields";
import { AdminAnchor } from "@/components/admin/admin-section";
import type { AdminData, Season } from "@/components/admin/season-admin-data";

const count = new Intl.NumberFormat("en-US");

/**
 * One setting, read first: its name and current value on one line, and
 * Edit opening its own form underneath. Set once at the start and rarely
 * touched after (the US log shows none of these used past setup), so the
 * values are what an admin reads and the forms stay shut.
 */
function SettingRow({
  label,
  value,
  children,
}: {
  label: string;
  value: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <details className="group/setting border-t border-line first:border-t-0">
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 py-2 [&::-webkit-details-marker]:hidden">
        <span className="w-36 shrink-0 text-xs text-muted">{label}</span>
        <span className="min-w-0 flex-1 basis-48 text-sm text-fg [overflow-wrap:anywhere]">
          {value}
        </span>
        <span className={buttonClasses("secondary", "sm", "shrink-0")}>
          <span className="group-open/setting:hidden">Edit</span>
          <span className="hidden group-open/setting:inline">Close</span>
          <span className="sr-only"> {label.toLowerCase()}</span>
        </span>
      </summary>
      <div className="pb-3">{children}</div>
    </details>
  );
}

/**
 * The season's settings on the Season tab: name, match night, the soft MMR
 * limit, the draft settings and clocks, and series lengths. They used to
 * fold away inside the phase card on the old one-page admin.
 */
export function SeasonSettings({
  season,
  data,
}: {
  season: Season;
  data: AdminData;
}) {
  const configLocked = !draftSetupOpen(season.status, data.draft?.status);
  // What /me and /schedule print as the match night once fixtures have times.
  const fixturesNight = fixturesMatchNightLabel(data.matches);
  const maxMmrValue =
    season.maxMmr >= HARD_MMR_CEILING
      ? `Off: it equals the ${count.format(HARD_MMR_CEILING)} hard ceiling`
      : season.maxMmr > 0
        ? `${count.format(season.maxMmr)}: flags signups above it for review, never refuses`
        : "Off";
  return (
    <AdminAnchor id="adm-settings">
      <Card>
        <CardHeader
          headingLevel={2}
          title="Settings"
          subtitle="The season's name, match night, MMR limit, draft settings and series lengths. Edit opens each one's form."
        />
        <CardBody className="py-1">
          <SettingRow label="Season name" value={season.name}>
          <ActionForm
            action={renameSeason}
            hidden={{
              expectedActiveSeasonId: season.id,
              expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
            }}
            className="flex flex-wrap items-center gap-2 text-sm"
          >
            <label htmlFor="seasonName" className="text-muted">
              Season name
            </label>
            <input
              id="seasonName"
              name="name"
              type="text"
              maxLength={60}
              defaultValue={season.name}
              className="h-9 w-80 max-w-full rounded-md border border-line bg-surface-2/50 px-2 text-sm"
            />
            <SubmitButton variant="secondary" size="sm">
              Save name
            </SubmitButton>
            <span className="text-xs text-muted">
              the big title on the home page
            </span>
          </ActionForm>
          </SettingRow>
          <SettingRow
            label="Match night"
            value={
              fixturesNight
                ? `${fixturesNight} (from the fixtures)`
                : (season.matchSchedule ?? `${MATCH_SCHEDULE.label} (default)`)
            }
          >
          <ActionForm
            action={setMatchSchedule}
            hidden={{
              expectedActiveSeasonId: season.id,
              expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
            }}
            className="flex flex-wrap items-center gap-2 text-sm"
          >
            <label htmlFor="matchSchedule" className="text-muted">
              Match night
            </label>
            <input
              id="matchSchedule"
              name="matchSchedule"
              type="text"
              maxLength={80}
              defaultValue={season.matchSchedule ?? ""}
              placeholder={MATCH_SCHEDULE.label}
              className="h-9 w-80 max-w-full rounded-md border border-line bg-surface-2/50 px-2 text-sm"
            />
            <SubmitButton variant="secondary" size="sm">
              Save schedule
            </SubmitButton>
            <span className="text-xs text-muted">
              {/* Once fixtures have kickoffs, pages print the night most of
                  them use (a single moved week doesn't change it). */}
              {fixturesNight
                ? `players now see the night most fixtures use: ${fixturesNight}`
                : `shown before signup${season.matchSchedule ? "" : " · using default"}`}
            </span>
          </ActionForm>
          </SettingRow>
          <SettingRow label="Soft MMR limit" value={maxMmrValue}>
          <ActionForm
            action={setMaxMmr}
            hidden={{
              expectedActiveSeasonId: season.id,
              expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
            }}
            className="flex flex-wrap items-center gap-2 text-sm"
          >
            <label htmlFor="seasonMaxMmr" className="text-muted">
              Soft MMR limit
            </label>
            <input
              id="seasonMaxMmr"
              name="maxMmr"
              type="number"
              min={0}
              max={HARD_MMR_CEILING}
              defaultValue={season.maxMmr}
              className="h-9 w-28 rounded-md border border-line bg-surface-2/50 px-2 text-sm"
            />
            <SubmitButton variant="secondary" size="sm">
              Save limit
            </SubmitButton>
            <span className="text-xs text-muted">
              {season.maxMmr >= HARD_MMR_CEILING
                ? `equals the hard ceiling ${HARD_MMR_CEILING}, so it flags nobody and player pages don't mention it · set it lower to flag signups for review, or 0 to turn it off`
                : season.maxMmr > 0
                  ? `soft limit: signups over ${season.maxMmr} MMR still join the pool, flagged “over soft limit” under Needs review on the Signups card (People) · only the hard ceiling ${HARD_MMR_CEILING} refuses (no Immortals)`
                  : `no soft limit · hard ceiling ${HARD_MMR_CEILING} (no Immortals)`}
            </span>
          </ActionForm>
          </SettingRow>
          <SettingRow
            label="Draft settings"
            value={
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>
                  {season.teamSize} per team · {season.minTeams}-team goal · $
                  {season.draftBudget} budget, {season.budgetMmrWeight}% by MMR ·
                  clocks: bid {season.draftBidSeconds}s, uncontested{" "}
                  {season.draftUncontestedBidSeconds}s, nomination{" "}
                  {season.draftNominationSeconds}s
                </span>
                {configLocked ? <Badge>locked</Badge> : null}
              </span>
            }
          >
          {/* Editable until the auction starts. These used to be write-once at
              Create season, so changing your mind about team size or budget meant
              creating a NEW season and orphaning every signup so far. */}
          <ActionForm
            action={setDraftSettings}
            hidden={{
              expectedActiveSeasonId: season.id,
              expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
            }}
            className="flex flex-wrap items-end gap-2 text-sm"
          >
            <Field label="Team size" htmlFor="cfgTeamSize">
              <input
                id="cfgTeamSize"
                name="teamSize"
                type="number"
                min={2}
                max={10}
                defaultValue={season.teamSize}
                className="h-9 w-24 rounded-md border border-line bg-surface-2/50 px-2 text-sm"
              />
            </Field>
            <Field label="Min teams" htmlFor="cfgMinTeams">
              <input
                id="cfgMinTeams"
                name="minTeams"
                type="number"
                min={2}
                max={32}
                defaultValue={season.minTeams}
                className="h-9 w-24 rounded-md border border-line bg-surface-2/50 px-2 text-sm"
              />
            </Field>
            <Field label="Draft budget ($)" htmlFor="cfgBudget">
              <input
                id="cfgBudget"
                name="draftBudget"
                type="number"
                min={10}
                defaultValue={season.draftBudget}
                className="h-9 w-28 rounded-md border border-line bg-surface-2/50 px-2 text-sm"
              />
            </Field>
            <Field label="Budget MMR weight %" htmlFor="cfgWeight">
              <input
                id="cfgWeight"
                name="budgetMmrWeight"
                type="number"
                min={0}
                max={50}
                defaultValue={season.budgetMmrWeight}
                className="h-9 w-28 rounded-md border border-line bg-surface-2/50 px-2 text-sm"
              />
            </Field>
            {/* The auction's clocks, fixed once it starts. The bounds are
                the engine's (DRAFT_CLOCK_LIMITS), which the action clamps
                to and its toast states. */}
            <Field label="Bid clock (s)" htmlFor="cfgBidSeconds">
              <input
                id="cfgBidSeconds"
                name="draftBidSeconds"
                type="number"
                min={DRAFT_CLOCK_LIMITS.bidSeconds.min}
                max={DRAFT_CLOCK_LIMITS.bidSeconds.max}
                defaultValue={season.draftBidSeconds}
                className="h-9 w-24 rounded-md border border-line bg-surface-2/50 px-2 text-sm"
              />
            </Field>
            <Field label="Uncontested lot (s)" htmlFor="cfgUncontestedSeconds">
              <input
                id="cfgUncontestedSeconds"
                name="draftUncontestedBidSeconds"
                type="number"
                min={DRAFT_CLOCK_LIMITS.uncontestedBidSeconds.min}
                max={DRAFT_CLOCK_LIMITS.uncontestedBidSeconds.max}
                defaultValue={season.draftUncontestedBidSeconds}
                className="h-9 w-24 rounded-md border border-line bg-surface-2/50 px-2 text-sm"
              />
            </Field>
            <Field label="Nomination clock (s)" htmlFor="cfgNominationSeconds">
              <input
                id="cfgNominationSeconds"
                name="draftNominationSeconds"
                type="number"
                min={DRAFT_CLOCK_LIMITS.nominationSeconds.min}
                max={DRAFT_CLOCK_LIMITS.nominationSeconds.max}
                defaultValue={season.draftNominationSeconds}
                className="h-9 w-24 rounded-md border border-line bg-surface-2/50 px-2 text-sm"
              />
            </Field>
            <SubmitButton variant="secondary" size="sm" disabled={configLocked}>
              Save draft settings
            </SubmitButton>
            <span className="text-xs text-muted">
              {configLocked
                ? draftSetupLockedMessage(season.status, data.draft?.status)
                : "applied when the draft starts · every bid resets the bid clock; a lot no other team can top gets the uncontested one"}
            </span>
          </ActionForm>
          </SettingRow>
          <SettingRow
            label="Series lengths"
            value={`Regular season Bo${season.regularBestOf} · playoffs Bo${season.playoffBestOf} · grand final Bo${season.finalBestOf}`}
          >
          <ActionForm
            action={setSeriesLengths}
            hidden={{
              expectedActiveSeasonId: season.id,
              expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
            }}
            className="flex flex-wrap items-end gap-3 text-sm"
          >
            <SeriesField
              label="Regular season"
              name="regularBestOf"
              value={season.regularBestOf}
              options={[1, 2, 3]}
            />
            <SeriesField
              label="Playoffs"
              name="playoffBestOf"
              value={season.playoffBestOf}
              options={[1, 3, 5, 7]}
            />
            <SeriesField
              label="Grand final"
              name="finalBestOf"
              value={season.finalBestOf}
              options={[1, 3, 5, 7]}
            />
            <SubmitButton variant="secondary" size="sm">
              Save series lengths
            </SubmitButton>
            {/* Each Match row carries its own length, copied when it is
                created. Saving once wrote only the Season, so an existing
                grand final stayed Bo5 under a "Bo3" setting; setSeriesLengths
                now moves every fixture that has not started, and its toast
                names what moved and what it left. */}
            <span className="text-xs text-muted">
              games per match — saving also updates every match that hasn&apos;t
              kicked off yet. Matches already played or under way keep their
              length, and tiebreakers keep theirs.
            </span>
          </ActionForm>
          </SettingRow>
        </CardBody>
      </Card>
    </AdminAnchor>
  );
}
