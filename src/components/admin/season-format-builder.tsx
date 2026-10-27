"use client";

// The season builder (/admin): the admin's layout for the season, a live
// preview of what it makes for the team count, the other layouts that fit,
// and the forms that save it or build the schedule from it. The preview and
// the actions judge with the same pure functions (season-builder.ts), so the
// card never offers a season the schedule won't build.

import { useId, useState } from "react";
import { generateSchedule } from "@/app/actions/admin-schedule-results";
import { saveSeasonFormat } from "@/app/actions/admin-season";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { DangerSubmit } from "@/components/danger-submit";
import { LocalDatetimeField } from "@/components/local-datetime-field";
import { SeasonPlanList } from "@/components/season-plan";
import { Button } from "@/components/ui";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import {
  FORMAT_CHOICES,
  formatAlternatives,
  formatDiff,
  formatToken,
  knobsLabel,
  previewSeasonFormat,
  sameKnobs,
  type FormatEditMode,
} from "@/lib/season-builder";
import {
  describeSeasonFormat,
  parseFormatConfig,
  recommendedKnobs,
  resolveSeasonFormat,
  seasonLengthPhrase,
  type FormatKnobs,
} from "@/lib/season-format";
import { cn } from "@/lib/utils";

const COUNT = new Intl.NumberFormat("en-US");
/** The preview stepper's range: a season needs two teams. */
const PREVIEW_MIN = 2;
const PREVIEW_MAX = 32;

type Choice = { recommended: boolean; knobs: FormatKnobs };

function initialChoice(formatConfig: string | null, teamCount: number): Choice {
  const stored = parseFormatConfig(formatConfig);
  if (stored.kind === "CUSTOM") return { recommended: false, knobs: stored.knobs };
  return {
    recommended: true,
    knobs: recommendedKnobs(teamCount) ?? { groups: 1, meet: 1, playoffs: 2 },
  };
}

const GROUP_LABELS: Record<number, string> = { 1: "One table", 2: "Two groups" };
const MEET_LABELS: Record<number, string> = { 1: "Once", 2: "Twice" };

function playoffLabel(groups: number, playoffs: number): string {
  if (groups > 1) {
    const perGroup = playoffs / groups;
    return perGroup === 1 ? "Winner of each" : `Top ${perGroup} of each`;
  }
  return playoffs === 2 ? "Top 2 (the final)" : `Top ${playoffs}`;
}

function matchesLabel({ min, max }: { min: number; max: number }): string {
  return min === max ? COUNT.format(min) : `${COUNT.format(min)}–${COUNT.format(max)}`;
}

function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

export function SeasonFormatBuilder({
  placement,
  season,
  teamGroupKeys,
  mode,
  countFinal,
  regularCount,
  scheduleRevision,
  generateLockedReason,
  firstMatchNightTs,
  nowMs,
  regenerateConsequences,
}: {
  /** Setup (signups and the draft) saves only; the schedule card also generates. */
  placement: "setup" | "schedule";
  season: { id: string; name: string; formatConfig: string | null; updatedAt: string };
  /** One entry per team, withdrawn ones included: the field the format counts. */
  teamGroupKeys: (string | null)[];
  /** `formatEditState`; the page renders no builder while it is LOCKED. */
  mode: Exclude<FormatEditMode, "LOCKED">;
  /** The auction has started, so the team count can't change any more. */
  countFinal: boolean;
  regularCount: number;
  /** The fixtures shown (`regularScheduleRevision`), for Generate's claim. */
  scheduleRevision: string;
  /** Why Generate can't run now, or null when it can. */
  generateLockedReason: string | null;
  firstMatchNightTs: number | null;
  nowMs: number;
  /** What a regenerate destroys, for its confirm. */
  regenerateConsequences: string[];
}) {
  const teamCount = teamGroupKeys.length;
  const [previewCount, setPreviewCount] = useState(Math.max(teamCount, PREVIEW_MIN));
  const [choice, setChoice] = useState<Choice>(() =>
    initialChoice(season.formatConfig, Math.max(teamCount, PREVIEW_MIN)),
  );
  // A save or a rebuild puts the picks back on what is stored. Reset here
  // rather than remounting the card, so a First match night the admin typed
  // survives a Save; other season saves (draft night, settings) change
  // neither token and keep the admin's unsaved picks.
  const storedKey = `${formatToken(season.formatConfig)}:${scheduleRevision}`;
  const [seenKey, setSeenKey] = useState(storedKey);
  if (seenKey !== storedKey) {
    setSeenKey(storedKey);
    setChoice(initialChoice(season.formatConfig, Math.max(teamCount, PREVIEW_MIN)));
  }
  // Week 1 as the First match night box holds it, so the preview dates
  // follow the box; until it reports, the stored night.
  const nightDefault =
    firstMatchNightTs !== null && firstMatchNightTs >= nowMs ? firstMatchNightTs : null;
  const [typedNightTs, setTypedNightTs] = useState<number | null | undefined>(undefined);
  const ids = { groups: useId(), meet: useId(), playoffs: useId(), night: useId() };

  const count = countFinal ? teamCount : previewCount;
  const knobs = choice.recommended ? (recommendedKnobs(count) ?? choice.knobs) : choice.knobs;
  const canGenerate =
    placement === "schedule" && countFinal && generateLockedReason === null;
  const nightTs = canGenerate && typedNightTs !== undefined ? typedNightTs : firstMatchNightTs;
  const preview = previewSeasonFormat(
    knobs,
    count,
    nightTs !== null ? new Date(nightTs) : null,
    LEAGUE_CONFIG.timeZone,
  );
  const alternatives = count >= PREVIEW_MIN ? formatAlternatives(count) : [];
  const errors = preview?.problems.errors ?? [];
  const warnings = preview?.problems.warnings ?? [];
  const stored = parseFormatConfig(season.formatConfig);
  const unchanged =
    (stored.kind === "RECOMMENDED" && choice.recommended) ||
    (stored.kind === "CUSTOM" && !choice.recommended && sameKnobs(stored.knobs, knobs));

  // In a built season, what the fixtures were built as, and whether this
  // choice keeps their groups and rounds (only the playoff places move).
  const built =
    mode === "BUILT"
      ? resolveSeasonFormat(season, teamGroupKeys.map((groupKey) => ({ groupKey })), true)
      : null;
  // A regenerate keeps groups whose sizes still fit (currentGroups), so the
  // redraw is a choice whenever both layouts are groups of the same sizes.
  const keepsGroups =
    built?.kind === "GROUPS" &&
    preview?.format.kind === "GROUPS" &&
    built.groupSizes.join() === preview.format.groupSizes.join();
  // Fixtures built from a format this version can't read may not match its
  // guess at them, so only Regenerate replaces it (saveSeasonFormat refuses).
  const keepsFixtures =
    stored.kind !== "UNREADABLE" &&
    built !== null &&
    preview !== null &&
    built.kind === preview.format.kind &&
    built.doubleRound === preview.format.doubleRound &&
    built.groupSizes.join() === preview.format.groupSizes.join();
  const diff = built && preview ? formatDiff(built, preview.format) : "";

  // What the forms post: the layout shown, and the state the page was
  // rendered with, which the actions claim.
  const posted: Record<string, string> = choice.recommended
    ? { formatChoice: "RECOMMENDED" }
    : {
        formatChoice: "CUSTOM",
        groups: String(knobs.groups),
        meet: String(knobs.meet),
        playoffs: String(knobs.playoffs),
      };

  const pick = (next: Partial<FormatKnobs>) =>
    setChoice({ recommended: false, knobs: { ...knobs, ...next } });
  const optionClass = (selected: boolean) =>
    cn(
      "flex min-h-10 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm",
      selected ? "border-accent/60 bg-accent/10 text-fg" : "border-line text-muted hover:text-fg",
    );
  const knobRows = [
    { key: "groups", legend: "Groups", values: FORMAT_CHOICES.groups, label: (v: number) => GROUP_LABELS[v] },
    { key: "meet", legend: "Teams meet", values: FORMAT_CHOICES.meet, label: (v: number) => MEET_LABELS[v] },
    {
      key: "playoffs",
      legend: "Playoffs",
      values: FORMAT_CHOICES.playoffs,
      label: (v: number) => playoffLabel(knobs.groups, v),
    },
  ] as const;

  // Each group's off weeks and byes; equal groups share one sentence.
  const gapNote = preview
    ? [
        ...new Set(
          preview.groups.map((group) => {
            const where =
              preview.format.kind !== "GROUPS"
                ? "the table"
                : new Set(preview.format.groupSizes).size === 1
                  ? `each group of ${group.size}`
                  : `the group of ${group.size}`;
            if (group.offWeeks.length > 0) {
              return `${capitalized(where)} is off in week${
                group.offWeeks.length === 1 ? "" : "s"
              } ${group.offWeeks.join(", ")}.`;
            }
            return group.byesPerTeam > 0
              ? `In ${where}, each team has ${group.byesPerTeam} bye${group.byesPerTeam === 1 ? "" : "s"}.`
              : "";
          }),
        ),
      ]
        .filter(Boolean)
        .join(" ")
    : "";

  const showSave = mode === "OPEN" || keepsFixtures;
  const saveDisabled = unchanged || (countFinal && errors.length > 0);

  return (
    <section
      aria-label="Season builder"
      className="min-w-0 rounded-lg border border-line bg-surface-2/40 px-4 py-3"
    >
      <h3 className="text-sm font-medium text-fg">
        Season builder ·{" "}
        {countFinal
          ? `${COUNT.format(teamCount)} teams`
          : `${COUNT.format(teamCount)} captain${teamCount === 1 ? "" : "s"} so far`}
      </h3>
      <p className="mt-0.5 text-xs text-muted">
        Recommended follows the team count. Pick any setting below to choose
        the groups, how often teams meet and the playoff places yourself.
        {stored.kind === "UNREADABLE"
          ? mode === "BUILT"
            ? " The saved layout came from a newer version of the site; Regenerate schedule replaces it."
            : " The saved layout came from a newer version of the site; saving or generating here replaces it."
          : ""}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        {choice.recommended ? (
          <span className="text-fg">
            <b>Recommended</b>
            <span className="text-muted"> · {knobsLabel(knobs).toLowerCase()}</span>
          </span>
        ) : (
          <>
            <span className="text-fg">
              <b>Custom</b>
              <span className="text-muted"> · {knobsLabel(knobs).toLowerCase()}</span>
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setChoice({ recommended: true, knobs })}
            >
              Reset to Recommended
            </Button>
          </>
        )}
      </div>

      {!countFinal ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted">Preview with</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-label="Preview one team fewer"
            disabled={previewCount <= PREVIEW_MIN}
            onClick={() => setPreviewCount((n) => Math.max(PREVIEW_MIN, n - 1))}
          >
            −
          </Button>
          <span className="min-w-6 text-center font-medium text-fg" aria-live="polite">
            {COUNT.format(count)}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-label="Preview one team more"
            disabled={previewCount >= PREVIEW_MAX}
            onClick={() => setPreviewCount((n) => Math.min(PREVIEW_MAX, n + 1))}
          >
            +
          </Button>
          <span className="text-muted">
            teams (you have {COUNT.format(teamCount)} captain{teamCount === 1 ? "" : "s"})
          </span>
        </div>
      ) : null}

      <div className="mt-3 space-y-3">
        {knobRows.map((row) => (
          <fieldset key={row.key} className="min-w-0">
            <legend className="text-xs font-semibold uppercase tracking-wide text-muted">
              {row.legend}
            </legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {row.values.map((value) => (
                <label key={value} className={optionClass(knobs[row.key] === value)}>
                  <input
                    type="radio"
                    name={ids[row.key]}
                    className="accent-[var(--color-brand)]"
                    checked={knobs[row.key] === value}
                    onChange={() => pick({ [row.key]: value })}
                  />
                  {row.label(value)}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>

      <section aria-label="Season preview" className="mt-4 min-w-0 border-t border-line pt-3">
        {preview ? (
          <>
            <p aria-live="polite" className="text-sm font-medium text-fg">
              {errors.length > 0
                ? `This layout can't be built with ${COUNT.format(count)} teams.`
                : `${capitalized(seasonLengthPhrase(preview.format))}.`}
            </p>
            <p className="mt-1 text-xs text-muted">{describeSeasonFormat(preview.format)}</p>
            <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ["Weeks", errors.length > 0 ? "—" : COUNT.format(preview.format.totalWeeks)],
                ["Matches per team", matchesLabel(preview.format.matchesPerTeam)],
                [
                  "Groups",
                  preview.format.kind === "GROUPS"
                    ? preview.format.groupSizes.join(" and ")
                    : "One table",
                ],
                ["Fixtures", COUNT.format(preview.fixtures)],
              ].map(([term, value]) => (
                <div key={term} className="min-w-0 rounded-md bg-surface-2/60 px-3 py-2">
                  <dt className="text-xs text-muted">{term}</dt>
                  <dd className="text-sm font-medium text-fg [overflow-wrap:anywhere]">{value}</dd>
                </div>
              ))}
            </dl>
            {errors.length === 0 ? (
              <>
                <SeasonPlanList
                  plan={preview.plan}
                  label="Previewed season plan"
                  className="mt-2"
                />
                {gapNote ? <p className="mt-2 text-xs text-muted">{gapNote}</p> : null}
              </>
            ) : null}
            {errors.map((error) => (
              <p key={error} className="mt-1 text-xs text-danger-soft">
                {error}
              </p>
            ))}
            {warnings.map((warning) => (
              <p key={warning} className="mt-1 text-xs text-accent">
                {warning}
              </p>
            ))}
            {!countFinal ? (
              <p className="mt-1 text-xs text-muted">
                Captains can still change; this is the layout for{" "}
                {COUNT.format(count)} teams.
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted">A season needs at least 2 teams to preview.</p>
        )}
      </section>

      {alternatives.length > 0 ? (
        <section aria-label={`Other layouts for ${count} teams`} className="mt-4 min-w-0">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
            Other layouts for {COUNT.format(count)} teams
          </h4>
          <ul className="mt-1 divide-y divide-line">
            {alternatives.map((option) => {
              const label = knobsLabel(option.knobs);
              const active = choice.recommended
                ? option.recommended
                : sameKnobs(option.knobs, knobs);
              return (
                <li key={label} className="flex items-center gap-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-fg" title={label}>
                      {label}
                      {option.recommended ? (
                        <span className="ml-2 text-xs text-muted">Recommended</span>
                      ) : null}
                    </p>
                    <p className="text-xs text-muted">
                      {option.format.totalWeeks} weeks ·{" "}
                      {matchesLabel(option.format.matchesPerTeam)} matches per team
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant={active ? "accent" : "secondary"}
                    size="sm"
                    className="shrink-0"
                    aria-pressed={active}
                    aria-label={`Use ${label.toLowerCase()}`}
                    onClick={() =>
                      setChoice({ recommended: option.recommended, knobs: option.knobs })
                    }
                  >
                    Use
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-3">
        {showSave ? (
          <ActionForm
            action={saveSeasonFormat}
            hidden={{
              ...posted,
              expectedActiveSeasonId: season.id,
              expectedSeasonUpdatedAt: season.updatedAt,
            }}
          >
            <SubmitButton
              variant="secondary"
              size="sm"
              disabled={saveDisabled}
              confirm={
                mode === "BUILT" && diff
                  ? `Change the playoff places? ${diff}. The fixtures stay as they are.`
                  : undefined
              }
            >
              {mode === "BUILT" ? "Save format (the fixtures stay)" : "Save format"}
            </SubmitButton>
          </ActionForm>
        ) : null}
        {/* Mounted whenever Generate is allowed, even while the layout picked
            can't be built (its buttons are disabled then): unmounting the
            form would throw away a First match night the admin typed. */}
        {canGenerate ? (
          <ActionForm
            action={generateSchedule}
            hidden={{
              ...posted,
              expectedActiveSeasonId: season.id,
              expectedSchedule: scheduleRevision,
              expectedFormat: formatToken(season.formatConfig),
            }}
            className="flex flex-wrap items-center gap-2"
          >
            <label
              htmlFor={ids.night}
              className="text-xs text-muted"
              title="Week 1 plays at this time on the league's clock; each later week (and playoff round) is +7 days at the same time."
            >
              First match night
            </label>
            {/* Required: a fixture with no kickoff gets no check-in, no
                reminder, no automatic results and no pick'em lock. */}
            <LocalDatetimeField
              id={ids.night}
              name="firstNight"
              tsName="firstNightTs"
              required
              defaultTs={nightDefault ?? undefined}
              // A week 1 already past would schedule kickoffs nobody can
              // play; the server refuses it too.
              minTs={nowMs}
              timeZone={LEAGUE_CONFIG.timeZone}
              onTsChange={setTypedNightTs}
              className="h-8 rounded-md border border-line bg-surface-2/50 px-2 text-xs text-fg"
            />
            {regularCount > 0 ? (
              <>
                {/* A regenerate keeps the groups it finds while their sizes
                    still fit, so a swap survives a new first night. */}
                {keepsGroups ? (
                  <label
                    className="flex items-center gap-1.5 text-xs text-muted"
                    title="Deal the groups again by each roster's average signup MMR, undoing any swap. Unticked, the regenerated schedule keeps today's groups."
                  >
                    <input
                      type="checkbox"
                      name="redrawGroups"
                      className="h-3.5 w-3.5 accent-[var(--color-brand)]"
                    />
                    redraw the groups
                  </label>
                ) : null}
                {/* Regenerate deletes every regular fixture and recreates
                    them with NEW ids, so every check-in, pick'em pick,
                    standin booking and open reschedule proposal cascades
                    away, none of it archived. */}
                <DangerSubmit
                  token={season.name}
                  title="Replace the regular-season schedule?"
                  disabled={errors.length > 0}
                  consequences={[
                    diff && !keepsFixtures
                      ? `${diff}. All ${regularCount} regular-season fixture(s) are deleted and rebuilt for this layout${
                          keepsGroups ? `, in today's groups unless "redraw the groups" is ticked` : ""
                        }.`
                      : keepsGroups
                        ? `All ${regularCount} regular-season fixture(s) are deleted and recreated with new ids — the same pairings unless "redraw the groups" is ticked.`
                        : `All ${regularCount} regular-season fixture(s) are deleted and recreated — same pairings, new ids.`,
                    ...(diff && keepsFixtures ? [`The layout changes too: ${diff}.`] : []),
                    ...regenerateConsequences,
                  ]}
                  recovery="Playoff matches are untouched. A rebuild puts every kickoff back on the weekly grid from the first match night, so moved weeks and accepted reschedules aren't kept, and none of the check-ins, picks or bookings can be restored."
                >
                  Regenerate schedule
                </DangerSubmit>
              </>
            ) : (
              <SubmitButton
                variant="secondary"
                size="sm"
                disabled={errors.length > 0}
                confirm={`Generate the regular-season schedule as ${knobsLabel(knobs).toLowerCase()}?${
                  preview ? ` ${capitalized(seasonLengthPhrase(preview.format))}.` : ""
                }${warnings.length > 0 ? ` ${warnings.join(" ")}` : ""}`}
              >
                Generate schedule
              </SubmitButton>
            )}
          </ActionForm>
        ) : placement === "schedule" && generateLockedReason ? (
          <p className="max-w-sm text-xs text-muted">
            {regularCount > 0 ? "Regenerate schedule" : "Generate schedule"} is unavailable:{" "}
            {generateLockedReason}
          </p>
        ) : null}
      </div>
    </section>
  );
}
