import {
  DRAFT_STATUS,
  REGISTRATION_TYPE,
  SEASON_STATUS,
} from "@/lib/constants";
import { addCaptain } from "@/app/actions/admin-captains-draft";
import { withdrawSignup, reinstateSignup } from "@/app/actions/admin-roster";
import {
  getGuildConfig,
  sweepGuildMemberships,
  type GuildMembership,
} from "@/lib/discord-roles";
import { signupNeedsReview } from "@/lib/signup-readiness";
import {
  signupRemovalBlockers,
  type SignupRemovalBlocker,
} from "@/lib/registration";
import { AdminSignupReview } from "@/components/admin-signup-review";
import { draftSetupOpen } from "@/lib/draft-setup";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { AdminPlayerRankEditor } from "@/components/admin-player-rank-editor";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  PlayerLink,
  RankMedal,
} from "@/components/ui";
import { AdminAnchor } from "@/components/admin/admin-section";
import type { AdminData, Season } from "@/components/admin/season-admin-data";
import {
  ROW_META_LINE,
  SignupRowMeta,
  regSignupFlags,
} from "@/components/admin/signup-row-meta";

/**
 * Stands in for a signup row's "remove" when withdrawSignup would only refuse
 * it (see signupRemovalBlockers): says why, and the title says what to do.
 */
function RemovalBlockedNote({ blocker }: { blocker: SignupRemovalBlocker }) {
  return (
    <span className="text-xs text-muted" title={blocker.fix}>
      {blocker.note}
    </span>
  );
}

/**
 * Everyone signed up this season, on People: the players not captaining
 * (make captain, remove, medal and MMR), the registered standins, and the
 * removed signups that can be reinstated. Teams sits above it; the auction
 * is the Draft card on Season.
 */
export function SignupControls({
  season,
  data,
}: {
  season: Season;
  data: AdminData;
}) {
  const setupOpen = draftSetupOpen(season.status, data.draft?.status);
  const captainUserIds = new Set(data.teams.map((t) => t.captainId));
  const nonCaptains = data.players.filter((p) => !captainUserIds.has(p.userId));
  // Real STANDIN registrations, for the moderation list below (data.standins
  // also carries undrafted PLAYERs for the cover dropdowns — those rows are
  // already in the eligible list above).
  const standinRegs = data.standins.filter(
    (s) => s.type === REGISTRATION_TYPE.STANDIN,
  );
  // Rows withdrawSignup can only refuse (rostered, or owing cover on an
  // unplayed match) get a note instead of a "remove" button. Mid-season that
  // is every drafted player in the list below.
  const removalBlockers = signupRemovalBlockers({
    teams: data.teams,
    assignments: data.assignments,
    matches: data.matches,
  });
  // The signup lists' "is this player actually IN the Discord server?" chips.
  // STARTED here, never awaited: this card is on /admin's blocking path, which
  // must stay Discord-free (the DiscordSection rule) — each row's chip
  // suspends on this promise individually, so the list and its make-captain /
  // remove controls paint immediately and the chips stream in when the
  // rate-paced sweep answers. The catch degrades a sweep-level failure to the
  // chips' honest "couldn't check" state; a Discord outage must never cost the
  // panel. (The funnel card and the Start-draft confirm sweep the same ids —
  // the membership memo and its in-flight dedupe make the third consumer
  // nearly free.)
  const guildCfg = getGuildConfig();
  const linkedIds = [
    ...new Set(
      [...nonCaptains, ...standinRegs]
        .map((p) => p.user.discordId)
        .filter((id): id is string => !!id),
    ),
  ];
  const membershipSweep =
    guildCfg && linkedIds.length > 0
      ? sweepGuildMemberships(linkedIds, guildCfg).catch(
          () => new Map<string, GuildMembership>(),
        )
      : null;

  return (
    <AdminAnchor id="adm-signups">
      <Card>
        <CardHeader
          headingLevel={2}
          title="Signups"
          subtitle={
            setupOpen
              ? "Review signups and make captains: each captain becomes a team in Teams above."
              : "Every active player and standin signup, and the removed ones, which can be reinstated."
          }
        />
        <CardBody>
            <h3 className="mb-2 text-sm font-medium text-muted">
              {setupOpen ? "Eligible players" : "Active player signups"}
            </h3>
            {/* One scroll surface on a phone: the page. The list only gets its
                own scroller from md up, where it sits beside the captains.
                Each row wraps like the captain rows: the name keeps a real
                width and the actions drop below it on a phone, and the
                "wants C" / "private data" badges ride in the chip line, where
                they used to overlap "make captain". */}
            {nonCaptains.length === 0 ? (
              <p className="text-sm text-muted">
                {setupOpen
                  ? "No other active full-player signups. At least one undrafted player is required to start."
                  : "No other active full-player signups."}
              </p>
            ) : (
              // "Needs review" narrows this to the signups worth a look before
              // the draft. The soft MMR limit is a review threshold, not a
              // block, and this is the review tool it points at.
              <AdminSignupReview
                label={setupOpen ? "Eligible players" : "Active player signups"}
                listClassName="space-y-1.5 md:max-h-[32rem] md:overflow-y-auto md:pr-1 md:has-[details[open]]:max-h-[70vh]"
                rowClassName="rounded-lg border border-line px-3 py-1.5 text-sm"
                rows={nonCaptains.map((p) => ({
                  key: p.id,
                  name: p.user.name,
                  needsReview: signupNeedsReview(
                    regSignupFlags(p, season.maxMmr),
                    !!p.user.discordId,
                  ),
                  node: (
                    <>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="flex min-w-0 flex-1 basis-48 items-center gap-2">
                          <Avatar
                            name={p.user.name}
                            src={p.user.avatar}
                            size={22}
                          />
                          <PlayerLink
                            userId={p.userId}
                            className="min-w-12 truncate"
                          >
                            {p.user.name}
                          </PlayerLink>
                          {/* Medal beside the claimed number: the pair is what
                              makes an inflated claim scannable, and the flag
                              below states the window when they disagree. */}
                          <RankMedal
                            rankTier={p.user.rankTier}
                            size={18}
                            className="shrink-0"
                          />
                          <span className="shrink-0 text-xs text-muted">
                            {p.mmr}
                          </span>
                        </span>
                        <span className="ml-auto flex shrink-0 items-center gap-3">
                          {setupOpen ? (
                            <ActionForm
                              action={addCaptain}
                              hidden={{
                                userId: p.userId,
                                expectedActiveSeasonId: season.id,
                              }}
                            >
                              {/* Confirmed because an undo can be expensive:
                                  removing a captain again deletes the team and,
                                  once fixtures exist, the season's whole
                                  schedule. Change captain is the cheap way back.
                                  Also a real SubmitButton, so it has a pending
                                  state and can't be double-submitted. */}
                              <SubmitButton
                                variant="ghost"
                                size="sm"
                                className="text-xs text-accent hover:underline"
                                confirm={`Make ${p.user.name} a captain? They get their own team. Change captain can hand that team to someone else later; removing the team also clears the schedule once one exists.`}
                              >
                                make captain
                              </SubmitButton>
                            </ActionForm>
                          ) : null}
                          {/* NOT phase-gated. This used to render only during
                              SIGNUPS and was the action's only control anywhere, so
                              from the moment the draft started an admin could not
                              remove a signup at all — while the action itself has no
                              phase gate and carries an explicit "player is on the
                              block" guard, i.e. it was written to be used mid-draft.
                              A player who ghosts after signing up stayed in the
                              auction pool (where the stall resolver can sell them),
                              and afterwards in the free-agent and standin dropdowns
                              for the rest of the season. `withdrawGateError` is the
                              real gate — it refuses a captain, a rostered player, a
                              standin who still owes cover, and a non-ACTIVE row.
                              Rows it can only refuse (removalBlockers) show why
                              instead of a button that can only error. */}
                          {season.status !== SEASON_STATUS.COMPLETE ? (
                            removalBlockers.has(p.userId) ? (
                              <RemovalBlockedNote blocker={removalBlockers.get(p.userId)!} />
                            ) : (
                              <ActionForm
                                action={withdrawSignup}
                                hidden={{ registrationId: p.id }}
                              >
                                <SubmitButton
                                  variant="ghost"
                                  size="sm"
                                  className="text-danger-soft hover:underline"
                                  confirm={
                                    season.status === "SIGNUPS"
                                      ? `Remove ${p.user.name}'s signup? They leave the player pool and can't re-add themselves — you can reinstate them below.`
                                      : `Remove ${p.user.name}'s signup? They leave the draft pool and the free-agent and standin lists — you can reinstate them below.`
                                  }
                                >
                                  remove
                                </SubmitButton>
                              </ActionForm>
                            )
                          ) : null}
                        </span>
                      </div>
                      {/* The chips and the medal editor's summary share a
                          line (the editor, opened, takes the full width): a
                          line each made every row about 24px taller. */}
                      <div className={ROW_META_LINE}>
                      <SignupRowMeta
                        reg={p}
                        sweep={membershipSweep}
                        maxMmr={season.maxMmr}
                        leading={
                          <>
                            {p.wantsCaptain ? (
                              <Badge tone="accent">wants C</Badge>
                            ) : null}
                            {p.user.fhUnavailable === true ? (
                              <Badge
                                tone="danger"
                                title="OpenDota reports their match data as private — automatic result import can't see this player's games"
                              >
                                private data
                              </Badge>
                            ) : null}
                          </>
                        }
                      />
                      {season.status !== SEASON_STATUS.COMPLETE ? (
                        <AdminPlayerRankEditor
                          key={`${p.id}:${p.mmr}:${p.user.rankTier}:${p.user.rankTierManual}`}
                          registrationId={p.id}
                          name={p.user.name}
                          mmr={p.mmr}
                          rankTier={p.user.rankTier}
                          rankTierManual={p.user.rankTierManual}
                          mmrLocked={data.draft?.status === DRAFT_STATUS.IN_PROGRESS || data.draft?.status === DRAFT_STATUS.PAUSED}
                        />
                      ) : null}
                      </div>
                    </>
                  ),
                }))}
              />
            )}
            {/* Registered STANDINs get the same moderation as players. Standin
                signups stay open through PLAYOFFS, and
                until this list existed the remove/MMR controls rendered only
                over type=PLAYER rows — so a troll or duplicate standin signup
                sat in every standin dropdown, the reach funnel and the reminder
                machinery all season with no button anywhere to touch it. The
                actions never had a type gate; this was a missing render.
                (Undrafted PLAYERs in data.standins are covered by the eligible
                list above — standinRegs, hoisted above for the membership
                sweep, is filtered to real STANDIN registrations.) */}
            {(() => {
              if (standinRegs.length === 0) return null;
              return (
                <div className="mt-4 border-t border-line/60 pt-3">
                  <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
                    Registered standins ({standinRegs.length})
                  </h4>
                  <ul
                    aria-label="Registered standins"
                    className="space-y-1.5 md:max-h-80 md:overflow-y-auto md:pr-1"
                  >
                    {standinRegs.map((s) => (
                      <li
                        key={s.id}
                        className="rounded-lg border border-line px-3 py-1.5 text-sm"
                      >
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="flex min-w-0 flex-1 basis-48 items-center gap-2">
                            <Avatar
                              name={s.user.name}
                              src={s.user.avatar}
                              size={22}
                            />
                            <PlayerLink
                              userId={s.userId}
                              className="min-w-12 truncate"
                            >
                              {s.user.name}
                            </PlayerLink>
                            <RankMedal
                              rankTier={s.user.rankTier}
                              size={18}
                              className="shrink-0"
                            />
                            <span className="shrink-0 text-xs text-muted">
                              {s.mmr}
                            </span>
                          </span>
                          {season.status !== SEASON_STATUS.COMPLETE ? (
                            removalBlockers.has(s.userId) ? (
                              <span className="ml-auto shrink-0">
                                <RemovalBlockedNote blocker={removalBlockers.get(s.userId)!} />
                              </span>
                            ) : (
                              <ActionForm
                                action={withdrawSignup}
                                hidden={{ registrationId: s.id }}
                                className="ml-auto shrink-0"
                              >
                                <SubmitButton
                                  variant="ghost"
                                  size="sm"
                                  className="text-danger-soft hover:underline"
                                  confirm={`Remove ${s.user.name}'s standin signup? They leave the standin lists and can't re-add themselves — you can reinstate them below.`}
                                >
                                  remove
                                </SubmitButton>
                              </ActionForm>
                            )
                          ) : null}
                        </div>
                        <div className={ROW_META_LINE}>
                        <SignupRowMeta
                          reg={s}
                          sweep={membershipSweep}
                          maxMmr={season.maxMmr}
                        />
                        {season.status !== SEASON_STATUS.COMPLETE ? (
                          <AdminPlayerRankEditor
                            key={`${s.id}:${s.mmr}:${s.user.rankTier}:${s.user.rankTierManual}`}
                            registrationId={s.id}
                            name={s.user.name}
                            mmr={s.mmr}
                            rankTier={s.user.rankTier}
                            rankTierManual={s.user.rankTierManual}
                          />
                        ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}
            {/* Removal is sticky (the player can't re-add themselves from /me),
                so it has to be undoable from here. */}
            {data.removed.length > 0 ? (
              <div className="mt-4 border-t border-line/60 pt-3">
                <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
                  Removed signups ({data.removed.length})
                </h4>
                <div className="space-y-1.5">
                  {data.removed.map((r) => (
                    <div
                      key={r.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-1.5 text-sm"
                    >
                      <span className="min-w-0 truncate text-muted">
                        {r.user.name}
                      </span>
                      {season.status === SEASON_STATUS.COMPLETE ? null : r.type ===
                          REGISTRATION_TYPE.PLAYER &&
                        (data.draft?.status === DRAFT_STATUS.IN_PROGRESS ||
                          data.draft?.status === DRAFT_STATUS.PAUSED) ? (
                        // reinstateSignup refuses a player signup while the
                        // auction runs (they'd rejoin a pool mid-lot), so say
                        // when it opens instead of offering a button that fails.
                        <span className="shrink-0 text-xs text-muted">
                          reinstate after the auction
                        </span>
                      ) : (
                        <ActionForm
                          action={reinstateSignup}
                          hidden={{ registrationId: r.id }}
                        >
                          <SubmitButton variant="ghost" size="sm">
                            reinstate
                          </SubmitButton>
                        </ActionForm>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
        </CardBody>
      </Card>
    </AdminAnchor>
  );
}
