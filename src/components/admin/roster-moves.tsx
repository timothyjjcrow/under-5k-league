import { shortTeams } from "@/lib/admin-attention";
import { DRAFT_STATUS, REGISTRATION_TYPE } from "@/lib/constants";
import {
  signFreeAgent,
  releasePlayer,
  promoteStandinToPlayer,
} from "@/app/actions/admin-roster";
import { freeAgentSeatLabel } from "@/lib/free-agent-rule";
import { standinMmrLabel } from "@/lib/standin";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardBody, CardHeader } from "@/components/ui";
import { selectCls } from "@/components/admin/admin-fields";
import type { AdminData, Season } from "@/components/admin/season-admin-data";
import { rosterMovesVisible } from "@/components/admin/season-admin-rules";

// Post-draft roster management: sign free agents onto short teams, release
// players who've left the league (they return to the free-agent pool).
export function RosterMoves({ season, data }: { season: Season; data: AdminData }) {
  // Visibility lives in `rosterMovesVisible` so the jump bar can ask the same
  // question. All three actions refuse until the auction has FINISHED
  // (signFreeAgent and releasePlayer check `draftRow.status !== COMPLETE`;
  // promoteGateError blocks a LIVE/PAUSED draft), and the card used to be gated
  // on the season phase alone — so from the first sale of draft night it sat
  // there fully populated with three forms that could only produce errors, with
  // "Release player" listing every player just bought.
  if (!rosterMovesVisible(season, data)) return null;

  // Pre-start DRAFT (phase walked forward, auction not yet run): promotion is
  // the ONLY legal move — promoteGateError blesses it ("they'll be auctioned
  // normally") while signFreeAgent/releasePlayer refuse until the auction is
  // COMPLETE. Rendering their forms here would be the controls-that-only-error
  // class, and the short-team banner would cry wolf over rosters that are
  // legitimately just captains.
  const preStart =
    season.status === "DRAFT" &&
    (!data.draft || data.draft.status === DRAFT_STATUS.NOT_STARTED);

  const rosteredIds = new Set(
    data.teams.flatMap((t) => t.members.map((m) => m.userId)),
  );
  const freeAgents = data.players.filter((p) => !rosteredIds.has(p.userId));
  // Withdrawn teams are neither an alarm nor a signing target: their fixtures
  // are all forfeited, so "short" is their permanent state (usually WHY they
  // withdrew), and signFreeAgent refuses them — offering them here parks a
  // player on a dead roster one mis-click away. Releasing their players stays
  // available below; that's the legitimate post-withdrawal cleanup.
  const short = preStart
    ? []
    : shortTeams(data.teams, season.teamSize).map(({ team }) => team);
  const canSign = !preStart && freeAgents.length > 0 && short.length > 0;
  const releasable = preStart
    ? []
    : data.teams.flatMap((t) =>
        t.members
          .filter((m) => !m.isCaptain)
          .map((m) => ({ id: m.id, name: m.user.name, teamName: t.name })),
      );
  // Late joiners register as standins once signups close — promoting one is
  // the first step of the mid-season roster refill (promote → sign above).
  // `data.standins` deliberately unions registered STANDINs with undrafted full
  // PLAYERs (both are valid cover), but promoteStandinToPlayer only accepts a
  // STANDIN — promoteGateError refuses everyone else. Without this filter the
  // dropdown was mostly names whose promotion always errors.
  const promotableStandins = data.standins.filter(
    (s) => s.type === REGISTRATION_TYPE.STANDIN && !rosteredIds.has(s.userId),
  );
  // (The "nothing to move" early return that used to live here is part of
  // rosterMovesVisible now — one predicate, so the jump chip can't outlive the
  // card it points at.)

  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="Roster moves"
        subtitle={
          preStart
            ? "Promote late-joining standins to full players — before the auction runs, a promoted player simply joins the draft pool."
            : "Sign free agents onto short teams; release players who've left; promote late-joining standins to full players."
        }
      />
      <CardBody className="space-y-3">
        {/* A SHORT ROSTER stated outright. The only place /admin printed a
            team's size against teamSize was inside the sign form's own team
            select — which is gated on a free agent existing, so the single
            indicator that a team is a player down vanished in exactly the case
            where nobody is available to fix it. Everywhere else the league
            reports a 4-of-5 side as fully staffed, so this line is the admin's
            only warning before match night. */}
        {short.length > 0 ? (
          <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-fg">
            <b>
              {short.length} team
              {short.length === 1 ? " is" : "s are"} short of{" "}
              {season.teamSize}:
            </b>{" "}
            {short
              .map((t) => `${t.name} (${t.members.length})`)
              .join(", ")}
            .{" "}
            {freeAgents.length === 0
              ? "No free agents are available — promote a standin below, or arrange cover per match in Standin assignments."
              : "Sign a free agent below to fill the seat."}
          </p>
        ) : null}
        {canSign ? (
          <ActionForm
            action={signFreeAgent}
            className="flex flex-wrap items-center gap-2"
          >
            <select
              name="userId"
              required
              defaultValue=""
              aria-label="Free agent to sign"
              className={selectCls}
            >
              <option value="" disabled>
                Free agent…
              </option>
              {/* Worded like the team options beside it ("3,200 MMR",
                  "MMR unknown"): an unknown is not 0. */}
              {freeAgents.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.user.name} ({standinMmrLabel(p.mmr)})
                </option>
              ))}
            </select>
            <span className="text-xs text-muted">joins</span>
            <select
              name="teamId"
              required
              defaultValue=""
              aria-label="Team with an open seat"
              className={selectCls}
            >
              <option value="" disabled>
                Team…
              </option>
              {/* Each team's yardstick for the 100-MMR rule, so the gap
                  shows before submitting (the free agents show their MMR). */}
              {short.map((t) => {
                const baseline = data.freeAgentBaselines[t.id];
                return (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.members.length}/{season.teamSize})
                    {baseline ? ` · ${freeAgentSeatLabel(baseline)}` : ""}
                  </option>
                );
              })}
            </select>
            {/* The free agent is held to 100 MMR above the player they
                replace (or the team's lowest MMR); over it, or with an MMR
                unknown, signFreeAgent refuses unless this is ticked, and the
                toast, the log and the Discord post say so with both MMRs. */}
            <label
              className="flex items-center gap-1.5 text-xs text-muted"
              title="Over 100 MMR above the player they replace (or the team's lowest MMR), or with an MMR unknown, a signing needs this ticked. The announcement then shows both MMRs."
            >
              <input
                type="checkbox"
                name="overMmrRule"
                className="h-3.5 w-3.5 accent-[var(--color-brand)]"
              />
              Sign over the 100-MMR rule
            </label>
            {/* Additive and undoable by Release — but Release permanently
                erases the player's draft price, so the round trip is lossy. */}
            <SubmitButton
              variant="secondary"
              size="sm"
              confirm="Sign this player onto that team for the rest of the season? Releasing them again frees the seat but permanently erases their draft price."
            >
              Sign player
            </SubmitButton>
          </ActionForm>
        ) : null}

        {promotableStandins.length > 0 ? (
          <ActionForm
            action={promoteStandinToPlayer}
            className="flex flex-wrap items-center gap-2"
          >
            <select
              name="userId"
              required
              defaultValue=""
              aria-label="Standin to promote to full player"
              className={selectCls}
            >
              <option value="" disabled>
                Standin…
              </option>
              {promotableStandins.map((s) => (
                <option key={s.userId} value={s.userId}>
                  {s.user.name}
                  {s.mmr > 0 ? ` (${s.mmr} MMR)` : ""}
                </option>
              ))}
            </select>
            <SubmitButton
              variant="secondary"
              size="sm"
              confirm={
                preStart
                  ? "Promote to full player? They join the draft pool and will be auctioned normally on draft night."
                  : "Promote to full player? They leave the standin pool and can be signed onto a roster."
              }
            >
              Promote to player
            </SubmitButton>
            <span className="text-xs text-muted">
              {preStart
                ? "they join the draft pool and get auctioned normally"
                : "then sign them with the form above — it appears once a team is short and a free agent exists"}
            </span>
          </ActionForm>
        ) : null}
        {releasable.length > 0 ? (
          <ActionForm
            action={releasePlayer}
            className="flex flex-wrap items-center gap-2"
          >
            <select
              name="memberId"
              required
              defaultValue=""
              aria-label="Rostered player to release"
              className={selectCls}
            >
              <option value="" disabled>
                Rostered player…
              </option>
              {releasable.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.teamName})
                </option>
              ))}
            </select>
            <SubmitButton
              variant="secondary"
              size="sm"
              className="text-danger-soft"
              confirm="Release this player from their roster? They go back to the free-agent pool, their fee is refunded to the team, and any standin booked to cover them on an unplayed match is cancelled (that standin is told to stand down in Discord)."
            >
              Release player
            </SubmitButton>
          </ActionForm>
        ) : null}
        {!preStart ? (
          <p className="text-xs text-muted">
            Signings and releases last the rest of the season (unlike standins,
            which cover a single match) and are announced in Discord. Both are
            reversible from this card — release undoes a signing and refunds it,
            and a released player goes back to the free-agent list. Captains
            can&apos;t be released; hand over captaincy first.
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
