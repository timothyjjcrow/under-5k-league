"use client";

import { Fragment, useId } from "react";
import {
  Avatar,
  Badge,
  PlayerLink,
  RankBadge,
  RoleBadges,
  buttonClasses,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { avgKnownMmr, queueSlots } from "@/lib/inhouse";
import { INHOUSE } from "@/lib/constants";
import { roleCoverage } from "@/lib/pool-stats";
import { parseRoleOrder } from "@/lib/roles";
import type { InhouseState } from "@/lib/inhouse-service";
import { RolePicker } from "@/components/inhouse/role-picker";

/**
 * An unsaved positions choice, tied to the saved value it was edited from. The
 * room holds it (like the typed MMR), because the queue's controls move
 * between cards as games form and end, and a remount must not drop it.
 */
export type RolesDraft = { value: string; base: string };

type QueueControlProps = {
  me: InhouseState["me"];
  pending: boolean;
  mmr: number;
  setMmr: (n: number) => void;
  rolesDraft: RolesDraft | null;
  setRolesDraft: (draft: RolesDraft | null) => void;
  mmrHint: string | null;
  signupMmr: number;
  act: (body: Record<string, unknown>) => void;
  nextGame?: boolean;
};

/** MMR on a hydrated client: one locale, so the server's "7,200" never hydrates as "7.200". */
const MMR_FORMAT = new Intl.NumberFormat("en-US");
const formatMmr = (mmr: number) => MMR_FORMAT.format(mmr);

/**
 * The filled queue card's phone grid (below md; md and lg have their own):
 * four columns, the 40px ring's, a context column, the title's rest and the
 * action. Row 1 is the ring, the title (over the middle two) and the action
 * (Join, Leave or Sign in); row 2 is one context cell (the MMR box, the
 * signup's MMR or your place in line) and the positions beside it. The
 * whole queue on a phone's first screen with Safari's toolbars showing
 * (Tim, 2026-10-11).
 */
const PHONE_GRID = {
  grid: "grid-cols-[2.5rem_auto_minmax(0,1fr)_auto]",
  title: "max-md:col-span-2",
  join: "max-md:col-start-4 max-md:row-start-1 max-md:justify-self-end",
  context: "max-md:col-span-2 max-md:col-start-1 max-md:row-start-2 max-md:w-30 max-md:self-start",
  positions: "max-md:col-span-2 max-md:col-start-3 max-md:row-start-2 max-md:min-w-0",
} as const;

/**
 * The positions shown and what a join sends. The picker holds an unsaved
 * choice until Join or "Save positions" sends it. It is tied to the saved
 * value it was edited from, so a save (or a change from another tab) that
 * moves the saved value drops the stale draft instead of showing it as
 * unsaved.
 */
function useQueueJoin({
  me,
  mmr,
  rolesDraft,
}: Pick<QueueControlProps, "me" | "mmr" | "rolesDraft">) {
  const saved = me.roles ?? { roles: "", source: "none" as const };
  const shownRoles =
    rolesDraft && rolesDraft.base === saved.roles
      ? rolesDraft.value
      : saved.roles;
  const rolesDirty = shownRoles !== saved.roles;
  // Only an edited choice rides along with a join; untouched, the stored one
  // (or the league signup's) stands, as it does for auto-join and Run it back.
  const joinBody = rolesDirty
    ? { action: "join", mmr, roles: parseRoleOrder(shownRoles) }
    : { action: "join", mmr };
  return { saved, shownRoles, rolesDirty, joinBody };
}

type QueueJoin = ReturnType<typeof useQueueJoin>;

/**
 * The queue's one control: sign in, leave, or join (with the MMR box when no
 * league signup sets it). On a phone it is 44px high with a narrower MMR
 * box, so the box and Join share one line (stacked, they cost the empty
 * card its first screen). `compact` is the filled card's layout: on a phone
 * (below md) the form's wrapper steps aside (`contents`) so Join takes the
 * ring row's end and the MMR box, its "MMR" label inside the box, sits
 * beside the positions in the card's grid (QueueView places them).
 */
function QueueAction({
  me,
  pending,
  mmr,
  setMmr,
  signupMmr,
  act,
  nextGame = false,
  join,
  compact = false,
}: Pick<
  QueueControlProps,
  "me" | "pending" | "mmr" | "setMmr" | "signupMmr" | "act" | "nextGame"
> & { join: QueueJoin; compact?: boolean }) {
  const mmrInputId = useId();
  // A phone's size: a 44px button, not 48 (40, the kit's small control
  // there, in the filled card's ring row, beside its 40px ring).
  const big = cn(compact ? "max-md:h-10" : "max-md:h-11", "max-md:px-4 max-md:text-sm");
  if (!me.isLoggedIn) {
    return (
      <a href="/login?next=/inhouse" className={buttonClasses("primary", "lg", big)}>
        {nextGame ? "Sign in for next game" : "Sign in to queue"}
      </a>
    );
  }
  if (me.inQueue) {
    return (
      <button
        type="button"
        disabled={pending}
        onClick={() => act({ action: "leave" })}
        className={buttonClasses("secondary", "lg", big)}
      >
        Leave queue
      </button>
    );
  }
  // joinQueue always uses the league signup MMR when there is one, so an
  // input there would be a control that does nothing.
  const joinButton = (
    <button
      type="button"
      disabled={pending}
      onClick={() => act(join.joinBody)}
      className={buttonClasses(
        "accent",
        "lg",
        cn(big, compact && signupMmr <= 0 && PHONE_GRID.join),
      )}
    >
      {nextGame ? "Join next-game queue →" : "Join queue →"}
    </button>
  );
  if (signupMmr > 0) return joinButton;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2",
        compact ? "max-md:contents md:justify-center" : "justify-center",
      )}
    >
      {/* The label and the box, laid out as they always were (`contents`),
          except in the filled card on a phone: one 40px box with the label
          inside it, beside the positions. */}
      <div
        className={cn(
          compact
            ? cn(
                "md:contents",
                PHONE_GRID.context,
                "max-md:flex max-md:h-10 max-md:items-center max-md:gap-1 max-md:rounded-lg max-md:border max-md:border-line max-md:bg-surface-2/50 max-md:pl-2 max-md:focus-within:border-accent/60",
              )
            : "contents",
        )}
      >
        <label
          htmlFor={mmrInputId}
          className={cn("text-sm text-muted", compact && "max-md:shrink-0 max-md:text-xs")}
        >
          MMR
        </label>
        {/* w-32: at w-24 the padding and the number spinner left
            "e.g. 3200" cut to "e.g. 32". A phone's w-28 (so Join fits
            beside it) gives back the padding instead. The filled card's
            phone box is the input's border: 120px, as a phone draws the
            input at 16px (globals.css, against iOS zoom), and 40px high,
            the input filling it (the box is the target, its label inside
            focusing the input), so the phones' 44px field minimum gives
            way; no spinner, which ate "e.g. 3200". */}
        <input
          id={mmrInputId}
          type="number"
          min={0}
          max={12000}
          inputMode="numeric"
          value={mmr || ""}
          placeholder="e.g. 3200"
          onChange={(e) => setMmr(Number(e.target.value))}
          title="Seeds captain selection and the balance meter."
          className={cn(
            "h-11 w-28 rounded-lg border border-line bg-surface-2/50 px-2 text-center text-sm outline-none focus:border-accent/60 md:w-32 md:px-3",
            compact &&
              "max-md:h-full max-md:min-h-0! max-md:w-auto max-md:min-w-0 max-md:flex-1 max-md:border-0 max-md:bg-transparent max-md:px-0.5 max-md:text-left max-md:[appearance:textfield] max-md:[&::-webkit-inner-spin-button]:appearance-none max-md:[&::-webkit-outer-spin-button]:appearance-none",
          )}
        />
      </div>
      {joinButton}
    </div>
  );
}

/**
 * Which MMR a league signup joins at, shown under its Join button. `phoneCell`
 * is the filled card's phone context cell: two short lines ("4,350 MMR",
 * "from your signup") beside the positions, the same words for a screen
 * reader.
 */
function SignupMmrNote({
  signupMmr,
  className,
  phoneCell = false,
}: {
  signupMmr: number;
  className?: string;
  phoneCell?: boolean;
}) {
  return (
    <p
      className={cn(
        "text-xs text-muted",
        phoneCell && "max-md:flex max-md:h-10 max-md:flex-col max-md:justify-center max-md:leading-4",
        className,
      )}
    >
      <span>
        <span className={cn(phoneCell && "max-md:sr-only")}>Joining at </span>
        <span className="tabular-nums text-fg">{formatMmr(signupMmr)}</span> MMR
        <span className={cn(phoneCell && "max-md:sr-only")}>,</span>
      </span>{" "}
      <span className={cn(phoneCell && "max-md:text-[11px]")}>
        from your <span className={cn(phoneCell && "max-md:hidden")}>league </span>
        signup
      </span>
    </p>
  );
}

/** The positions picker and, while it's edited, "Save positions". */
function QueuePositions({
  pending,
  setRolesDraft,
  act,
  join,
  queueCard = false,
  phoneRow = false,
  saveClassName,
}: Pick<QueueControlProps, "pending" | "setRolesDraft" | "act"> & {
  join: QueueJoin;
  /** The filled queue card's dense layout (RolePicker `queueCard`). */
  queueCard?: boolean;
  /** The empty queue card's phone row (RolePicker `phoneRow`). */
  phoneRow?: boolean;
  saveClassName: string;
}) {
  const { saved, shownRoles, rolesDirty } = join;
  return (
    <>
      <RolePicker
        value={shownRoles}
        onChange={(next) => setRolesDraft({ value: next, base: saved.roles })}
        source={rolesDirty ? "inhouse" : saved.source}
        disabled={pending}
        queueCard={queueCard}
        phoneRow={phoneRow}
      />
      {rolesDirty ? (
        <div className={saveClassName}>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              act({ action: "roles", roles: parseRoleOrder(shownRoles) })
            }
            className={buttonClasses("secondary", "sm")}
          >
            Save positions
          </button>
        </div>
      ) : null}
    </>
  );
}

/**
 * How the typed MMR is checked. Stays visible after joining: it's the
 * explanation for why the listed MMR can differ from what was typed.
 */
function QueueMmrHint({
  mmrHint,
  className,
  dense = false,
  phoneDense = false,
}: {
  mmrHint: string;
  className?: string;
  /**
   * The filled queue card: a 24px summary (WCAG 2.5.8's size, with nothing
   * else within reach), and opened it takes the whole row it shares.
   */
  dense?: boolean;
  /** The 24px summary on a phone only (the empty queue's card). */
  phoneDense?: boolean;
}) {
  return (
    <details className={cn("text-xs text-muted", dense && "open:basis-full", className)}>
      <summary
        className={cn(
          "inline-flex min-h-8 cursor-pointer items-center rounded px-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
          dense && "min-h-6",
          phoneDense && "max-md:min-h-6",
        )}
      >
        How your MMR is set
      </summary>
      <p className="mt-1 text-left leading-relaxed">{mmrHint}</p>
    </details>
  );
}

/**
 * The single join/leave/sign-in control used by the empty queue and the
 * compact live-lobby card, stacked: the action, the positions, the MMR
 * note. The filled queue card lays the same parts out in its own grid.
 * Keeping them one set of components prevents the live path from drifting
 * back to a hidden API-only affordance.
 */
function QueueControls({
  me,
  pending,
  mmr,
  setMmr,
  rolesDraft,
  setRolesDraft,
  mmrHint,
  signupMmr,
  act,
  nextGame = false,
  phoneCompact = false,
}: QueueControlProps & {
  /**
   * The empty queue's card on a phone (below md): the picker's label beside
   * its toggles and a 24px "How your MMR is set", tighter, so the card keeps
   * a phone's first screen. md and up render exactly what shipped.
   */
  phoneCompact?: boolean;
}) {
  const join = useQueueJoin({ me, mmr, rolesDraft });
  const action = (
    <QueueAction
      me={me}
      pending={pending}
      mmr={mmr}
      setMmr={setMmr}
      signupMmr={signupMmr}
      act={act}
      nextGame={nextGame}
      join={join}
    />
  );
  return (
    <div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        {me.isLoggedIn && !me.inQueue && signupMmr > 0 ? (
          <div className="flex flex-col items-center gap-2">
            {action}
            <SignupMmrNote signupMmr={signupMmr} className="text-center" />
          </div>
        ) : (
          action
        )}
      </div>

      {me.isLoggedIn ? (
        <QueuePositions
          pending={pending}
          setRolesDraft={setRolesDraft}
          act={act}
          join={join}
          phoneRow={phoneCompact}
          saveClassName="mt-2 flex justify-center"
        />
      ) : null}

      {mmrHint ? (
        <QueueMmrHint
          mmrHint={mmrHint}
          phoneDense={phoneCompact}
          className={cn("mt-3 text-center", phoneCompact && "max-md:mt-1.5")}
        />
      ) : null}
    </div>
  );
}

/** A small entry point above a lobby for people who are not part of that game. */
export function NextGameQueueCard({
  state,
  pending,
  mmr,
  setMmr,
  rolesDraft,
  setRolesDraft,
  mmrHint,
  signupMmr,
  act,
}: Omit<QueueControlProps, "me" | "nextGame"> & { state: InhouseState }) {
  const titleId = useId();
  const present = state.queue.filter((q) => !q.away).length;

  return (
    <section
      aria-labelledby={titleId}
      className="rounded-[var(--radius)] border border-accent/30 bg-accent/5 px-4 py-4 sm:px-5"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={titleId} className="font-semibold">
              Queue for the next game
            </h2>
            <Badge tone="accent">{present} queued</Badge>
          </div>
          <p className="mt-1 max-w-xl text-sm text-muted">
            {state.liveGames >= state.maxLiveGames
              ? `${state.liveGames === 2 ? "Both games are" : "Every game is"} underway. The next ready check starts when one finishes.`
              : "This game is underway. Ten in the queue start another game alongside it."}
          </p>
        </div>
        <div className="shrink-0">
          <QueueControls
            me={state.me}
            pending={pending}
            mmr={mmr}
            setMmr={setMmr}
            rolesDraft={rolesDraft}
            setRolesDraft={setRolesDraft}
            mmrHint={mmrHint}
            signupMmr={signupMmr}
            act={act}
            nextGame
          />
        </div>
      </div>
    </section>
  );
}

export function QueueView({
  state,
  pending,
  mmr,
  setMmr,
  rolesDraft,
  setRolesDraft,
  mmrHint,
  signupMmr,
  firstGame,
  act,
  nextGame = false,
}: {
  state: InhouseState;
  pending: boolean;
  mmr: number;
  setMmr: (n: number) => void;
  rolesDraft: RolesDraft | null;
  setRolesDraft: (draft: RolesDraft | null) => void;
  mmrHint: string | null;
  signupMmr: number;
  firstGame: boolean;
  act: (body: Record<string, unknown>) => void;
  /** Shown beside a live game: the queue for the game after it. */
  nextGame?: boolean;
}) {
  const { queue, lobbySize, needed, me } = state;
  // Every game slot is taken, so a full queue waits for a game to finish;
  // with a slot free, ten queued players start another game at once.
  const waitsForGame = nextGame && state.liveGames >= state.maxLiveGames;
  // "Away" players (heartbeat gone quiet, or re-queued by a cancelled lobby
  // and not back yet) stay queued but don't count toward forming. queueSlots
  // keeps them out of the ten slots, which are for players who are here, and
  // the room lists them on their own line with a plain explanation.
  const present = queue.filter((q) => !q.away);
  const pct = lobbySize
    ? Math.min(100, Math.round((present.length / lobbySize) * 100))
    : 0;
  // Rough lobby strength while it fills. avgKnownMmr owns the "0 = unknown,
  // excluded" rule — this only adds the sample floor, so one lone known MMR
  // isn't presented as the room's calibre.
  const knownMmrs = present.map((q) => q.mmr).filter((m) => m > 0);
  const queueAvg = knownMmrs.length >= 2 ? avgKnownMmr(knownMmrs) : 0;
  const { slots, overflow, away } = queueSlots(queue, lobbySize);
  // How many present players list each position, so the queue can see a
  // missing support before ten form (positions are preferences: a nudge to
  // flex, never a rule). Quiet until someone has set positions.
  const coverage = roleCoverage(present.map((q) => ({ roles: q.roles })));
  const showCoverage =
    present.length >= 2 && coverage.some((role) => role.count > 0);

  const myPosition = present.findIndex((q) => q.userId === me.userId) + 1;
  // The filled card lays the controls' parts out in its own grid.
  const join = useQueueJoin({ me, mmr, rolesDraft });
  const mmrForm = me.isLoggedIn && !me.inQueue && signupMmr <= 0;
  // Phone-sized coverage pills (16px), in the "Who's playing" row.
  const smallPill = "max-md:h-4 max-md:min-w-4 max-md:px-0.5 max-md:text-[10px]";
  // A phone's slot pills, 14px: the slot's second line is 14px high, so a
  // row is 32px (the name's line keeps its 16px, the link's 24px target).
  const slotPill = "max-md:h-3.5 max-md:min-w-3.5 max-md:px-0.5 max-md:text-[10px] max-md:leading-none";

  const controls = (
    <QueueControls
      me={me}
      pending={pending}
      mmr={mmr}
      setMmr={setMmr}
      rolesDraft={rolesDraft}
      setRolesDraft={setRolesDraft}
      mmrHint={mmrHint}
      signupMmr={signupMmr}
      act={act}
      nextGame={nextGame}
      phoneCompact
    />
  );

  return (
    <div className="space-y-3">
      {present.length === 0 ? (
        <EmptyQueueCard
          lobbySize={lobbySize}
          away={away}
          controls={controls}
          nextGame={nextGame}
        />
      ) : (
        // The whole card fits the first screen (Tim, 2026-10-10: the entire
        // queue on screen when you open /inhouse), a laptop's browser window
        // and a phone with Safari's toolbars showing too (2026-10-11). Below
        // md, two rows of controls (PHONE_GRID): the 40px ring, the title
        // and the action, then one context cell (the MMR box, the signup's
        // MMR or "You're queued" and your place) beside the positions; the
        // slots are 32px rows and the positions count rides the "Who's
        // playing" row. From md the ring is 128px over the title (beside it
        // from lg), with 48px slot rows and, from lg, the picker's short
        // label beside its toggles.
        <section
          aria-label={nextGame ? "Next-game queue" : "Inhouse queue"}
          className="overflow-hidden rounded-2xl border border-accent/25 bg-surface/90 shadow-xl shadow-black/10"
        >
          <div className="grid md:grid-cols-[1fr_1.35fr] lg:grid-cols-[0.85fr_1.35fr]">
            <div className="relative overflow-hidden bg-[radial-gradient(ellipse_at_top_left,color-mix(in_srgb,var(--color-accent)_12%,transparent),transparent_75%)] px-3 pt-2.5 md:border-r md:border-line md:p-5 lg:py-4">
              <div
                className={cn(
                  "grid items-center gap-x-2.5 gap-y-2 md:grid-cols-1 md:justify-items-center md:gap-y-3 md:text-center lg:grid-cols-[auto_minmax(0,1fr)] lg:gap-x-5 lg:gap-y-2.5 lg:justify-items-start lg:text-left",
                  PHONE_GRID.grid,
                )}
              >
                <div className="relative grid h-10 w-10 shrink-0 place-items-center md:h-32 md:w-32">
                  <svg
                    viewBox="0 0 120 120"
                    aria-hidden
                    className="absolute inset-0 h-full w-full -rotate-90"
                  >
                    <circle
                      cx="60"
                      cy="60"
                      r="51"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="5"
                      className="text-line [stroke-width:9] md:[stroke-width:5]"
                    />
                    <circle
                      cx="60"
                      cy="60"
                      r="51"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="5"
                      pathLength="100"
                      strokeDasharray={`${pct} 100`}
                      strokeLinecap={pct > 0 ? "round" : "butt"}
                      className="text-accent transition-[stroke-dasharray] duration-500 [stroke-width:9] motion-reduce:transition-none md:[stroke-width:5]"
                    />
                  </svg>
                  <div
                    role="progressbar"
                    aria-label={
                      nextGame
                        ? "Next-game queue progress"
                        : "Inhouse queue progress"
                    }
                    aria-valuemin={0}
                    aria-valuemax={lobbySize}
                    aria-valuenow={Math.min(present.length, lobbySize)}
                    aria-valuetext={`${present.length} players queued; ${needed} more needed`}
                    className="text-center"
                  >
                    <span className="block font-display text-base font-bold leading-none tabular-nums md:text-4xl">
                      {present.length}
                    </span>
                    <span className="block text-[10px] leading-none text-muted md:mt-1 md:text-[11px] md:leading-normal">
                      of {lobbySize}
                      <span className="max-md:hidden"> players</span>
                    </span>
                  </div>
                </div>
                <div className={cn("min-w-0", PHONE_GRID.title)}>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent max-md:hidden">
                    {nextGame ? "Up next" : "Pick-up Dota"}
                  </p>
                  <h2 className="font-display text-base font-semibold tracking-tight max-md:leading-snug md:mt-1 md:text-2xl">
                    {nextGame ? "Next-game queue" : "Inhouse queue"}
                  </h2>
                  <p className="text-xs text-muted md:mt-1.5 md:text-sm">
                    {needed > 0 ? (
                      <>
                        {`${needed} more `}
                        <span className="max-md:hidden">
                          {needed === 1 ? "player " : "players "}
                        </span>
                        {/* A phone has no room for the "Who's playing"
                            row's "Ready check when a game finishes", so
                            the count carries it. */}
                        {waitsForGame ? (
                          <>
                            <span className="max-md:hidden">to play</span>
                            <span className="md:hidden">· waits for a game</span>
                          </>
                        ) : (
                          "to play"
                        )}
                      </>
                    ) : waitsForGame ? (
                      "Full · waiting for a game to finish"
                    ) : (
                      "Full · starting the ready check…"
                    )}
                  </p>
                  {queueAvg > 0 ? (
                    <p className="mt-2 text-xs tabular-nums text-muted max-md:hidden">
                      {formatMmr(queueAvg)} average MMR
                    </p>
                  ) : null}
                </div>
                {/* The action: on a phone the ring row's end (Join, Leave
                    or Sign in), with the MMR form's box stepping into row
                    2 beside the positions (QueueAction, PHONE_GRID). */}
                <div
                  className={
                    mmrForm
                      ? "max-md:contents md:col-span-full md:mt-2 md:justify-self-center"
                      : "justify-self-end md:col-span-full md:mt-2 md:justify-self-center"
                  }
                >
                  <QueueAction
                    me={me}
                    pending={pending}
                    mmr={mmr}
                    setMmr={setMmr}
                    signupMmr={signupMmr}
                    act={act}
                    nextGame={nextGame}
                    join={join}
                    compact
                  />
                </div>
                {me.isLoggedIn && !me.inQueue && signupMmr > 0 ? (
                  <SignupMmrNote
                    signupMmr={signupMmr}
                    phoneCell
                    className={cn("col-span-full md:w-full md:text-center", PHONE_GRID.context)}
                  />
                ) : null}
                {me.isLoggedIn ? (
                  <div className={cn("col-span-full w-full", PHONE_GRID.positions)}>
                    <QueuePositions
                      pending={pending}
                      setRolesDraft={setRolesDraft}
                      act={act}
                      join={join}
                      queueCard
                      saveClassName="mt-2 flex md:justify-center"
                    />
                  </div>
                ) : null}
                {/* Your place in line and the MMR note share a row
                    where they fit side by side (a laptop), and wrap
                    where they don't. On a phone the row steps aside:
                    your place is row 2's context cell, on two short
                    lines ("You're queued", "#2 in line"; the header's
                    badge gives way to it), and the MMR note sits under
                    the card. */}
                {me.inQueue || mmrHint ? (
                  <div className="col-span-full flex w-full flex-wrap items-center gap-x-3 gap-y-1 max-md:contents md:justify-center">
                    {me.inQueue ? (
                      <p
                        role="status"
                        className={cn(
                          "text-xs text-success max-md:flex max-md:h-10 max-md:flex-col max-md:justify-center max-md:leading-4",
                          PHONE_GRID.context,
                        )}
                      >
                        <span className="font-medium md:hidden">You’re queued</span>
                        <span>
                          {myPosition > 0 ? (
                            <>
                              <span className="max-md:hidden">You’re </span>#{myPosition} in line
                            </>
                          ) : (
                            "Your spot is saved"
                          )}
                          <span className="max-md:sr-only">
                            {nextGame ? " · next game" : " · listen for the ready check"}
                          </span>
                        </span>
                      </p>
                    ) : null}
                    {mmrHint ? (
                      <QueueMmrHint
                        mmrHint={mmrHint}
                        dense
                        className="max-md:hidden md:text-center"
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="min-w-0 px-3 pb-2.5 pt-2 md:p-4">
              {/* One line at every width: a second line here cost a phone
                  its first screen once wider type (Linux's DejaVu) wrapped
                  it. Below md, the average gives way first: it sits in a
                  one-line box after an empty line-high spacer, so when it
                  doesn't fit beside the counts it wraps onto the box's
                  clipped second line and disappears whole, never cut to
                  "4,4…" (from md it is under the ring). */}
              <div
                data-who-row
                className="mb-1 flex flex-nowrap items-center gap-x-2 md:mb-2 md:justify-between"
              >
                <h3 className="shrink-0 whitespace-nowrap text-xs font-semibold md:text-sm">
                  Who’s playing
                </h3>
                {queueAvg > 0 ? (
                  <span className="flex h-4 min-w-0 flex-1 flex-wrap overflow-hidden md:hidden">
                    <span aria-hidden className="h-4 w-0" />
                    <span className="whitespace-nowrap text-xs tabular-nums text-muted">
                      {formatMmr(queueAvg)} avg
                    </span>
                  </span>
                ) : null}
                {showCoverage ? (
                  <p className="ml-auto flex shrink-0 items-center gap-x-1 text-xs text-muted md:hidden">
                    <span className="sr-only">Positions queued:</span>
                    {coverage.map((role) => (
                      <span
                        key={role.key}
                        className={cn(
                          "inline-flex items-center tabular-nums",
                          role.count === 0 ? "text-accent" : "",
                        )}
                      >
                        <RoleBadges roles={role.key} pillClassName={smallPill} />×{role.count}
                      </span>
                    ))}
                  </p>
                ) : null}
                <span className="whitespace-nowrap text-xs text-muted max-md:hidden">
                  {waitsForGame ? (
                    "Ready check when a game finishes"
                  ) : (
                    <>First {lobbySize} in → ready check</>
                  )}
                </span>
              </div>
              <ul className="grid grid-cols-2 gap-1 md:gap-2">
                {slots.map((q, i) => {
                  if (!q) {
                    return (
                      <li
                        key={`open-${i}`}
                        className="flex min-h-8 items-center gap-1.5 rounded-lg border border-dashed border-line/70 px-1.5 md:min-h-12 md:gap-2 md:rounded-xl md:px-3 md:py-1"
                      >
                        <span
                          aria-hidden
                          className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-dashed border-line text-sm text-muted md:h-8 md:w-8"
                        >
                          +
                        </span>
                        <span className="min-w-0 text-xs text-muted">
                          Open slot
                          <span className="ml-1 tabular-nums">{i + 1}</span>
                        </span>
                      </li>
                    );
                  }
                  const isMe = q.userId === me.userId;
                  return (
                    <li
                      key={q.userId}
                      className={cn(
                        "flex min-h-8 min-w-0 items-center gap-1.5 rounded-lg border px-1.5 transition-colors md:min-h-12 md:gap-2 md:rounded-xl md:px-2.5 md:py-[3px]",
                        isMe
                          ? "border-accent/50 bg-accent/10"
                          : "border-line bg-surface-2/50",
                      )}
                    >
                      <Avatar
                        name={q.name}
                        src={q.avatar}
                        size={30}
                        className="shrink-0 max-md:h-6! max-md:w-6!"
                      />
                      <div className="min-w-0 flex-1">
                        {/* A phone's line 1: the name and the MMR; line 2
                            the slot (or "You" in your own: the room says
                            your place in line) and the positions. */}
                        <div className="flex min-w-0 items-center gap-1.5 text-xs">
                          <PlayerLink
                            userId={q.userId}
                            className="min-w-6 flex-1 truncate font-semibold sm:text-sm"
                          >
                            {q.name}
                          </PlayerLink>
                          {q.mmr > 0 ? (
                            <span className="shrink-0 tabular-nums text-muted md:hidden">
                              {formatMmr(q.mmr)}
                            </span>
                          ) : null}
                        </div>
                        <span className="flex items-center gap-x-1 text-xs text-muted max-md:leading-[14px] md:flex-wrap md:gap-x-1.5">
                          <span className={cn("tabular-nums", isMe && "max-md:hidden")}>
                            #{i + 1}
                          </span>
                          {isMe ? <span className="text-accent">You</span> : null}
                          {q.mmr > 0 ? (
                            <span className="tabular-nums max-md:hidden">
                              {formatMmr(q.mmr)} MMR
                            </span>
                          ) : null}
                          <RoleBadges
                            roles={q.roles}
                            ranked={q.rolesRanked}
                            labelled
                            className="flex-nowrap gap-px md:flex-wrap md:gap-1"
                            pillClassName={slotPill}
                          />
                        </span>
                      </div>
                      <span className="hidden xl:block">
                        <RankBadge rankTier={q.rankTier} />
                      </span>
                    </li>
                  );
                })}
              </ul>
              {showCoverage ? (
                <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted max-md:hidden">
                  <span>Positions queued:</span>
                  {coverage.map((role) => (
                    <span
                      key={role.key}
                      className={cn(
                        "inline-flex items-center gap-1 tabular-nums",
                        role.count === 0 ? "text-accent" : "",
                      )}
                    >
                      <RoleBadges roles={role.key} />×{role.count}
                    </span>
                  ))}
                </p>
              ) : null}
              {overflow.length > 0 ? (
                <div className="mt-3 border-t border-line/60 pt-3">
                  <div className="mb-2 text-xs text-muted">
                    Also queued · {overflow.length}
                  </div>
                  <ul className="flex flex-wrap gap-2">
                    {overflow.map((q) => (
                      <li
                        key={q.userId}
                        className="flex min-w-0 items-center gap-1.5 rounded-full border border-line bg-surface-2/40 py-1 pl-1 pr-2.5 text-xs"
                      >
                        <Avatar name={q.name} src={q.avatar} size={20} />
                        <PlayerLink
                          userId={q.userId}
                          className="max-w-32 truncate"
                        >
                          {q.name}
                        </PlayerLink>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {away.length > 0 ? (
                <AwayLine away={away} lobbySize={lobbySize} />
              ) : null}
            </div>
          </div>
        </section>
      )}
      {/* A phone's "How your MMR is set", right under the filled card (in
          it from md): the card keeps the first screen. */}
      {present.length > 0 && mmrHint ? (
        <QueueMmrHint mmrHint={mmrHint} dense className="px-1 text-center md:hidden" />
      ) : null}
      <p className="px-1 text-center text-xs text-muted">
        {/* A queued phone player's ready-check reminder, which the card keeps
            for screen readers only: here it costs no first-screen space. */}
        {me.inQueue && !nextGame ? (
          <span aria-hidden className="md:hidden">
            Listen for the ready check ·{" "}
          </span>
        ) : null}
        Tab switching keeps your spot · queue clears after{" "}
        {INHOUSE.QUEUE_IDLE_HOURS}h without lobby activity
      </p>
      {/* The page's ONE walkthrough of a game (the ladder card no longer
          repeats it). Open by default for a signed-in first-timer; gone once
          the viewer is queued, where "queue up" is advice they have already
          taken and the room itself explains each next step. */}
      {me.inQueue ? null : (
        <details
          open={firstGame}
          className="group rounded-xl border border-line bg-surface/60"
        >
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-xs text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 [&::-webkit-details-marker]:hidden">
            <span>
              New to inhouse?{" "}
              <span className="font-medium text-fg">The game plan</span>
            </span>
            <span
              aria-hidden
              className="transition-transform group-open:rotate-180"
            >
              ⌄
            </span>
          </summary>
          <ol className="grid gap-4 border-t border-line p-4 text-xs text-muted sm:grid-cols-2 lg:grid-cols-4">
            <li>
              <strong className="mb-1 block text-fg">
                01 · Queue & accept
              </strong>
              {lobbySize} players fill the room. Accept within{" "}
              {INHOUSE.ACCEPT_SECONDS}s or lose your spot.
            </li>
            <li>
              <strong className="mb-1 block text-fg">
                02 · Choose captains
              </strong>
              Elect players, use highest MMR, or pick by inhouse record.
            </li>
            <li>
              <strong className="mb-1 block text-fg">
                03 · Draft your side
              </strong>
              Captains pick Radiant and Dire in a snake draft: one pick, then
              pairs.
            </li>
            <li>
              <strong className="mb-1 block text-fg">
                04 · Play & climb
              </strong>
              Join the Dota lobby and your team&apos;s voice channel, then let
              results update your Elo.
            </li>
          </ol>
        </details>
      )}
    </div>
  );
}

/**
 * The queue with nobody in it — the state most visitors see. Ten dashed "Open
 * slot" boxes beside a 0/10 ring made the scene look dead and pushed the page
 * past 3,000px on a phone, so an empty queue is one compact card instead: what
 * an inhouse is, the join control, and how many are queued. The full slot
 * view returns the moment one present player is in.
 */
function EmptyQueueCard({
  lobbySize,
  away,
  controls,
  nextGame,
}: {
  lobbySize: number;
  away: InhouseState["queue"];
  controls: React.ReactNode;
  nextGame: boolean;
}) {
  return (
    <section
      aria-label={nextGame ? "Next-game queue" : "Inhouse queue"}
      className="rounded-2xl border border-accent/25 bg-surface/90 p-5 shadow-xl shadow-black/10 max-sm:p-4 sm:p-6"
    >
      {/* Below md, tighter (no eyebrow, a smaller title and blurb, the
          picker's label beside its toggles): with Safari's toolbars
          showing, the card keeps a phone's first screen. */}
      <div className="flex flex-col gap-5 max-md:gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent max-md:hidden">
            {nextGame ? "Up next" : "Pick-up Dota"}
          </p>
          <h2 className="mt-1 font-display text-2xl font-semibold tracking-tight max-md:mt-0 max-md:text-xl">
            {nextGame ? "Next-game queue" : "Inhouse queue"}
          </h2>
          <p className="mt-1.5 max-w-xl text-sm text-muted max-md:mt-1 max-md:text-xs">
            {lobbySize} players queue up, vote on captains, draft two teams and
            play one game of Dota. The result records itself and moves
            everyone&apos;s Elo.
          </p>
        </div>
        <div className="shrink-0">{controls}</div>
      </div>
      <div className="mt-5 flex items-center gap-3 max-md:mt-4">
        <div
          role="progressbar"
          aria-label={
            nextGame ? "Next-game queue progress" : "Inhouse queue progress"
          }
          aria-valuemin={0}
          aria-valuemax={lobbySize}
          aria-valuenow={0}
          aria-valuetext={`0 players queued; ${lobbySize} more needed`}
          className="flex min-w-0 flex-1 gap-1"
        >
          {Array.from({ length: lobbySize }, (_, i) => (
            <span key={i} className="h-2 flex-1 rounded-full bg-line" />
          ))}
        </div>
        <span className="shrink-0 text-sm tabular-nums text-muted">
          <strong className="text-fg">0</strong> / {lobbySize} queued
        </span>
      </div>
      {away.length > 0 ? <AwayLine away={away} lobbySize={lobbySize} /> : null}
    </section>
  );
}

/** Names shown on the away line before it says "and N more". */
const AWAY_NAMES_SHOWN = 10;

/**
 * Queued players who aren't on the page right now, on one line under the
 * slots. After an admin cancel this is all ten of the last lobby until their
 * tabs check in; the words say what the dimmed "away" tag only said in a
 * hover tooltip, which phones never show.
 */
function AwayLine({
  away,
  lobbySize,
}: {
  away: InhouseState["queue"];
  lobbySize: number;
}) {
  const shown = away.slice(0, AWAY_NAMES_SHOWN);
  const more = away.length - shown.length;
  return (
    <div className="mt-4 border-t border-line/60 pt-3 text-xs text-muted">
      <p>
        <span className="font-medium text-fg">
          Waiting for {away.length} {away.length === 1 ? "player" : "players"}{" "}
          to come back:
        </span>{" "}
        {shown.map((q, i) => (
          <Fragment key={q.userId}>
            {i > 0 ? ", " : null}
            <PlayerLink
              userId={q.userId}
              className="max-w-full truncate align-bottom"
            >
              {q.name}
            </PlayerLink>
          </Fragment>
        ))}
        {more > 0 ? ` and ${more} more` : null}
      </p>
      <p className="mt-1">
        They&apos;re still in the queue but not on this page right now. Each
        one counts toward the {lobbySize} again as soon as they open it.
      </p>
    </div>
  );
}
