import Link from "@/components/app-link";
import { DRAFT_STATUS, SEASON_STATUS } from "@/lib/constants";
import {
  changeCaptain,
  removeCaptain,
  transferCaptaincy,
} from "@/app/actions/admin-captains-draft";
import {
  renameTeam,
  withdrawTeam,
  reinstateTeam,
} from "@/app/actions/admin-roster";
import { DangerSubmit } from "@/components/danger-submit";
import {
  teamWithdrawalLockedReason,
  withdrawalKickedOffFixtures,
} from "@/lib/team-withdrawal";
import { mmrWeightedBudgets } from "@/lib/draft";
import { unverifiedCaptainMmrsFor } from "@/lib/captain-mmr";
import { captainTransferOpen, draftSetupOpen } from "@/lib/draft-setup";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { AdminPlayerRankEditor } from "@/components/admin-player-rank-editor";
import { TeamIdentityForm } from "@/components/team-identity-form";
import { isGeneratedTeamNameFor } from "@/lib/team-identity";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  PlayerLink,
  TeamCrest,
} from "@/components/ui";
import { AdminAnchor } from "@/components/admin/admin-section";
import { selectCls } from "@/components/admin/admin-fields";
import type { AdminData, Season } from "@/components/admin/season-admin-data";

/**
 * The season's teams, on People: one row per captain with its budget, name
 * and logo, captain changes and the captain's medal and MMR, then the
 * team-level withdrawal. Captains are made from Signups below; the auction
 * itself is the Draft card on Season.
 */
export function TeamControls({
  season,
  data,
  nowMs,
}: {
  season: Season;
  data: AdminData;
  nowMs: number;
}) {
  const setupOpen = draftSetupOpen(season.status, data.draft?.status);
  const transferOpen = captainTransferOpen(season.status, data.draft?.status);
  const teamWithdrawalLocked =
    teamWithdrawalLockedReason(season.status) ??
    (data.matches.some((m) => m.phase === "TIEBREAKER")
      ? "Reset the tiebreaker week before changing team eligibility."
      : null);
  const captainUserIds = new Set(data.teams.map((t) => t.captainId));
  const nonCaptains = data.players.filter((p) => !captainUserIds.has(p.userId));
  // Captains are ACTIVE PLAYER registrations too (addCaptain requires it), so
  // their row is in `data.players` — it is only filtered out of the list above.
  const captainReg = new Map(data.players.map((p) => [p.userId, p]));
  const regularCount = data.matches.filter((m) => m.phase === "REGULAR").length;
  const collateral = data.collateral;
  const unverifiedMmr = unverifiedCaptainMmrsFor(season, data);
  const unverifiedMmrByTeam = new Map(
    unverifiedMmr.map((c) => [c.teamId, c]),
  );


  // The auction is over (or never ran) once setup has closed and no lot can
  // sell: from then on a team row shows its roster, not a budget.
  const auctionOver =
    !setupOpen &&
    data.draft?.status !== DRAFT_STATUS.IN_PROGRESS &&
    data.draft?.status !== DRAFT_STATUS.PAUSED;

  return (
    <AdminAnchor id="adm-teams">
      <Card>
        <CardHeader
          headingLevel={2}
          title="Teams"
          subtitle={
            setupOpen
              ? "One team per captain. Make captains in Signups below; budgets are projected until the auction starts."
              : "Names and logos, captain hand-overs, and a team that quits the season."
          }
        />
        <CardBody>
            <h3 className="mb-2 text-sm font-medium text-muted">
              Captains ({data.teams.length})
            </h3>
            <div className="space-y-2">
              {data.teams.length === 0 ? (
                <p className="text-sm text-muted">
                  {setupOpen
                    ? "No captains yet. Use “make captain” beside an eligible player in Signups below; each designation creates their team."
                    : "No captain teams were recorded for this season."}
                </p>
              ) : (
                (() => {
                  // Preview the MMR-weighted budgets captains will start with.
                  const mmrByUser = new Map(
                    data.players.map((p) => [p.userId, p.mmr]),
                  );
                  const projected = mmrWeightedBudgets(
                    season.draftBudget,
                    season.budgetMmrWeight,
                    data.teams.map((t) => ({
                      teamId: t.id,
                      // `|| null`: stored 0 = unknown MMR → base budget (must
                      // match startDraft's mapping or projections lie).
                      mmr: mmrByUser.get(t.captainId) || null,
                    })),
                    season.teamSize - 1,
                  );
                  return data.teams.map((t) => (
                    <div
                      key={t.id}
                      className="rounded-lg border border-line px-3 py-2 text-sm"
                    >
                      {/* Wraps on a phone: the budget + remove drop to their
                          own line once the name's basis-48 can't fit beside
                          them, and the name itself wraps rather than truncates,
                          because the order number and crest take ~60px of that
                          basis (a long name read "The Couriers of Catastrophe
                          Wi…" at 390px). The captain is named in words under
                          the team: a Steam-less captain's avatar is only
                          initials, which named the link "RR" to a screen
                          reader and nobody at all to a sighted admin. */}
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="flex min-w-0 flex-1 basis-48 items-center gap-2">
                          <span className="w-5 shrink-0 text-center text-xs text-muted">
                            {t.draftOrder + 1}
                          </span>
                          <TeamCrest
                            name={t.name}
                            seed={t.id}
                            logoUrl={t.logoUrl}
                            size={28}
                          />
                          <span className="min-w-12 [overflow-wrap:anywhere]">
                            <Link
                              href={`/teams/${t.id}`}
                              className="hover:text-info hover:underline"
                            >
                              {t.name}
                            </Link>
                            <span className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted">
                              <span aria-hidden className="shrink-0">
                                <Avatar
                                  name={t.captain.name}
                                  src={t.captain.avatar}
                                  size={20}
                                />
                              </span>
                              <span className="min-w-0">
                                Captain{" "}
                                <PlayerLink userId={t.captainId}>
                                  {t.captain.name}
                                </PlayerLink>
                              </span>
                            </span>
                          </span>
                        </span>
                        <span className="ml-auto flex shrink-0 items-center gap-2">
                          {/* Budgets matter until the auction ends; after
                              it, the roster's size is what an admin needs,
                              and a short one is flagged. */}
                          {auctionOver ? (
                            <Badge
                              tone={
                                !t.withdrawn && t.members.length < season.teamSize
                                  ? "accent"
                                  : "neutral"
                              }
                              className="shrink-0"
                            >
                              {t.members.length}/{season.teamSize} players
                            </Badge>
                          ) : (
                            <Badge tone="accent" className="shrink-0">
                              $
                              {setupOpen
                                ? (projected.get(t.id) ?? t.budget)
                                : t.budget}
                              {setupOpen ? " projected" : null}
                            </Badge>
                          )}
                          {setupOpen ? (
                            <ActionForm
                              action={removeCaptain}
                              hidden={{
                                teamId: t.id,
                                expectedActiveSeasonId: season.id,
                              }}
                            >
                              {/* Once any fixture exists this deletes the team AND
                                  every match in the SEASON — taking all check-ins,
                                  pick'em picks, standin bookings and open proposals
                                  with it by cascade. It is the twin of Regenerate
                                  schedule and needs the same barrier; it was a bare
                                  `remove` link 12px from "✎ Rename team". With no
                                  schedule only the team goes, which a plain confirm
                                  covers (and Change captain keeps the team). */}
                              {regularCount === 0 ? (
                                <SubmitButton
                                  variant="ghost"
                                  size="sm"
                                  className="shrink-0 text-danger-soft hover:underline"
                                  confirm={`Remove ${t.captain.name} as captain and delete ${t.name}? Its name and logo go with it. To keep the team and hand it to someone else, use Change captain instead.`}
                                >
                                  remove
                                </SubmitButton>
                              ) : (
                              <DangerSubmit
                                token={t.name}
                                className="shrink-0"
                                title={`Remove ${t.captain.name} as captain and delete ${t.name}?`}
                                consequences={[
                                  `${t.name} and its ${t.members.length} roster place(s) are deleted.`,
                                  `All ${regularCount} fixture(s) in the season are cleared — not just this team's — because the round robin no longer fits.`,
                                  ...(collateral.rsvps
                                    ? [
                                        `${collateral.rsvps} check-in(s) go with them.`,
                                      ]
                                    : []),
                                  ...(collateral.picks
                                    ? [
                                        `${collateral.picks} pick'em pick(s) go with them.`,
                                      ]
                                    : []),
                                  ...(collateral.covers
                                    ? [
                                        `${collateral.covers} standin booking(s) go with them.`,
                                      ]
                                    : []),
                                ]}
                                recovery="Regenerate the schedule once the captains are final. The check-ins, picks and bookings cannot be restored."
                              >
                                remove
                              </DangerSubmit>
                              )}
                            </ActionForm>
                          ) : null}
                        </span>
                      </div>
                      {unverifiedMmrByTeam.has(t.id) ? (
                        /* Its own line, not beside the budget badge: that row
                           is already at its phone-width limit, and the reason
                           has to be readable without a hover. */
                        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                          <Badge tone="accent" className="shrink-0">
                            unverified MMR
                          </Badge>
                          <span className="min-w-0">
                            {unverifiedMmrByTeam.get(t.id)!.reason}
                          </span>
                        </p>
                      ) : null}
                      {/* The row's disclosures share one line, and the one
                          opened takes the full width under it: stacked, their
                          summaries took up to four lines a team. */}
                      <div className="mt-1.5 flex flex-wrap items-start gap-x-4 gap-y-1.5 empty:hidden [&>details]:mt-0 [&>details[open]]:basis-full">
                      {season.status !== SEASON_STATUS.COMPLETE ? (
                        <details className="mt-1.5">
                          <summary className="cursor-pointer text-xs text-muted hover:text-fg">
                            ✎ Edit team
                          </summary>
                          <div className="mt-1.5">
                            <TeamIdentityForm
                              key={`${t.name}|${t.logoUrl ?? ""}`}
                              action={renameTeam}
                              teamId={t.id}
                              name={t.name}
                              logoUrl={t.logoUrl}
                              hidden={{ expectedActiveSeasonId: season.id }}
                              note="Captains can also change this themselves on their team page."
                            />
                          </div>
                        </details>
                      ) : null}
                      {/* Before the draft a team is its captain alone, so handing it
                          to another signup keeps the team row: name, logo and
                          draft-order slot. The outgoing captain goes back to the
                          pool. Nothing is deleted, so a plain confirm. */}
                      {setupOpen && nonCaptains.length > 0 ? (
                        <details className="mt-1.5">
                          <summary className="cursor-pointer text-xs text-muted hover:text-fg">
                            ⇄ Change captain
                          </summary>
                          <ActionForm
                            action={changeCaptain}
                            className="mt-1.5 flex flex-wrap items-center gap-2"
                            hidden={{
                              teamId: t.id,
                              expectedActiveSeasonId: season.id,
                              expectedCaptainUserId: t.captainId,
                            }}
                          >
                            <select
                              name="newCaptainUserId"
                              required
                              defaultValue=""
                              aria-label={`New captain for ${t.name}`}
                              className={selectCls}
                            >
                              <option value="" disabled>
                                New captain…
                              </option>
                              {nonCaptains.map((p) => (
                                <option key={p.userId} value={p.userId}>
                                  {p.user.name}
                                </option>
                              ))}
                            </select>
                            <SubmitButton
                              variant="secondary"
                              size="sm"
                              confirm={`Hand ${t.name} to the selected player? ${t.captain.name} goes back to the player pool. The team keeps its logo and draft-order slot${isGeneratedTeamNameFor(t.name, t.captain.name) ? ", and its name follows the new captain" : ", and its name"}.`}
                            >
                              Change captain
                            </SubmitButton>
                          </ActionForm>
                          <p className="mt-1 text-xs text-muted">
                            Keeps the team, unlike remove. {t.captain.name} stays
                            signed up and can be drafted.
                          </p>
                        </details>
                      ) : null}
                      {season.status !== SEASON_STATUS.COMPLETE && captainReg.get(t.captainId) ? (
                        <AdminPlayerRankEditor
                          key={`${captainReg.get(t.captainId)!.id}:${captainReg.get(t.captainId)!.mmr}:${t.captain.rankTier}:${t.captain.rankTierManual}`}
                          registrationId={captainReg.get(t.captainId)!.id}
                          name={t.captain.name}
                          mmr={captainReg.get(t.captainId)!.mmr}
                          rankTier={t.captain.rankTier}
                          rankTierManual={t.captain.rankTierManual}
                          mmrLocked={data.draft?.status === DRAFT_STATUS.IN_PROGRESS || data.draft?.status === DRAFT_STATUS.PAUSED}
                        />
                      ) : null}
                      {/* Post-draft only: before the auction runs, removeCaptain
                          (which deletes the empty team) is the right tool. After
                          it, this is the ONLY way to move captaincy off an
                          inactive player — and it's what makes them releasable,
                          since releasePlayer refuses captains. */}
                      {transferOpen &&
                      !setupOpen &&
                      t.members.some((m) => m.userId !== t.captainId) ? (
                        <details className="mt-1.5">
                          <summary className="cursor-pointer text-xs text-muted hover:text-fg">
                            ⇄ Hand over captaincy
                          </summary>
                          <ActionForm
                            action={transferCaptaincy}
                            className="mt-1.5 flex flex-wrap items-center gap-2"
                            hidden={{
                              teamId: t.id,
                              expectedActiveSeasonId: season.id,
                              expectedCaptainUserId: t.captainId,
                            }}
                          >
                            <select
                              name="newCaptainUserId"
                              required
                              defaultValue=""
                              aria-label={`New captain for ${t.name}`}
                              className={selectCls}
                            >
                              <option value="" disabled>
                                New captain…
                              </option>
                              {t.members
                                .filter((m) => m.userId !== t.captainId)
                                .map((m) => (
                                  <option key={m.userId} value={m.userId}>
                                    {m.user.name}
                                  </option>
                                ))}
                            </select>
                            <SubmitButton
                              variant="secondary"
                              size="sm"
                              confirm={`Hand ${t.name} to a new captain? ${t.captain.name} stays on the roster as a normal player (you can release them afterwards).`}
                            >
                              Make captain
                            </SubmitButton>
                          </ActionForm>
                          <p className="mt-1 text-xs text-muted">
                            For a captain who&apos;s gone inactive — the team
                            keeps its own reschedule, standin and result-reporting
                            controls.
                          </p>
                        </details>
                      ) : null}
                      </div>
                      {t.withdrawn ? (
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                          <Badge>withdrew</Badge>
                          {teamWithdrawalLocked ? (
                            <span className="text-xs text-muted">
                              Reinstatement locked: {teamWithdrawalLocked}
                            </span>
                          ) : (
                            <ActionForm
                              action={reinstateTeam}
                              hidden={{
                                teamId: t.id,
                                expectedActiveSeasonId: season.id,
                              }}
                            >
                              <SubmitButton
                                variant="ghost"
                                size="sm"
                                confirm={`Reinstate ${t.name}? They rejoin playoff-seeding contention. Forfeited fixtures stay as recorded — reverse any you want undone with "Reopen for import" on each row, then rebook any standin cover (the withdrawal cancelled it).`}
                              >
                                reinstate
                              </SubmitButton>
                            </ActionForm>
                          )}
                        </div>
                      ) : null}
                    </div>
                  ));
                })()
              )}
            </div>
            {/* Team dropout — the most common amateur-league disaster, which used
                to be a weekly hand-typed-forfeit grind. ONE control with a team
                picker, deliberately: a DangerSubmit per team would put N client
                dialogs on the app's heaviest page (the release form beside it
                uses the same idiom). Mid-season only — pre-season the tool is
                removeCaptain, and a playoff slot needs an explicit per-match
                ruling, which the action's errors say. */}
            {!teamWithdrawalLocked && data.teams.some((t) => !t.withdrawn) ? (
              <details className="mt-3 rounded-lg border border-line px-3 py-2">
                <summary className="cursor-pointer text-xs text-muted hover:text-fg">
                  🏳️ A team has quit the season
                </summary>
                <ActionForm
                  action={withdrawTeam}
                  hidden={{ expectedActiveSeasonId: season.id }}
                  className="mt-2 flex flex-wrap items-center gap-2"
                >
                  <select
                    name="teamId"
                    required
                    defaultValue=""
                    aria-label="Team withdrawing from the season"
                    className={selectCls}
                  >
                    <option value="" disabled>
                      Team…
                    </option>
                    {/* The confirm's consequences are static strings on a
                        one-picker form, so the per-team REAL numbers (confirms
                        must name real numbers) ride in the option label:
                        standin bookings on the fixtures this withdrawal would
                        forfeit — either side's, since the opponent's cover dies
                        with the fixture too — and those fixtures already past
                        kickoff, which may have been played and only be waiting
                        on their import (withdrawalKickedOffFixtures). */}
                    {(() => {
                      const openRegular = data.matches.filter(
                        (m) => m.phase === "REGULAR" && m.status !== "COMPLETED",
                      );
                      const bookingsFor = (teamId: string) => {
                        const ids = new Set(
                          openRegular
                            .filter(
                              (m) =>
                                m.homeTeamId === teamId ||
                                m.awayTeamId === teamId,
                            )
                            .map((m) => m.id),
                        );
                        return data.assignments.filter((a) => ids.has(a.matchId))
                          .length;
                      };
                      return data.teams
                        .filter((t) => !t.withdrawn)
                        .map((t) => {
                          const n = bookingsFor(t.id);
                          const kickedOff = withdrawalKickedOffFixtures(
                            data.matches,
                            t.id,
                            nowMs,
                          ).length;
                          const notes = [
                            n > 0
                              ? `${n} standin booking(s) on their open fixtures`
                              : null,
                            kickedOff > 0
                              ? `${kickedOff} series past kickoff with no result`
                              : null,
                          ].filter(Boolean);
                          return (
                            <option key={t.id} value={t.id}>
                              {t.name}
                              {notes.length > 0 ? ` — ${notes.join(" · ")}` : ""}
                            </option>
                          );
                        });
                    })()}
                  </select>
                  <DangerSubmit
                    token={season.name}
                    title="Withdraw this team from the season?"
                    consequences={[
                      "Every unplayed regular fixture of the selected team is forfeited 0-N to the opponent; that official score counts in the game-diff tiebreak.",
                      "A series past its kickoff with no result on the site is forfeited too, even if it was played and its games just haven't imported yet: a final match takes no more games. The team picker counts these per team; wait for those results before withdrawing.",
                      "Open reschedule proposals on those fixtures are cancelled.",
                      "Standins booked on those fixtures — either side's — are stood down with an @-mention.",
                      "The team is excluded from playoff seeding — its played results and roster are kept.",
                    ]}
                    recovery={`"Reinstate" (beside the team above) undoes the exclusion, and each forfeited fixture without games is individually reversible with "Reopen for import". Standin bookings on those fixtures are cancelled, so rebook cover after reopening one.`}
                  >
                    Withdraw team
                  </DangerSubmit>
                </ActionForm>
              </details>
            ) : teamWithdrawalLocked && data.teams.some((t) => !t.withdrawn) ? (
              <p className="mt-3 rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-xs text-muted">
                Team withdrawal locked: {teamWithdrawalLocked}
              </p>
            ) : null}
        </CardBody>
      </Card>
    </AdminAnchor>
  );
}
