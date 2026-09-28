"use client";

import { Fragment, useId } from "react";
import {
  Avatar,
  Badge,
  PlayerLink,
  RankBadge,
  buttonClasses,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { avgKnownMmr, queueSlots } from "@/lib/inhouse";
import { INHOUSE } from "@/lib/constants";
import type { InhouseState } from "@/lib/inhouse-service";

type QueueControlProps = {
  me: InhouseState["me"];
  pending: boolean;
  mmr: number;
  setMmr: (n: number) => void;
  mmrHint: string | null;
  signupMmr: number;
  act: (body: Record<string, unknown>) => void;
  nextGame?: boolean;
};

/**
 * The single join/leave/sign-in control used by both the idle queue and the
 * compact live-lobby card. Keeping this in one component prevents the live
 * path from drifting back to a hidden API-only affordance.
 */
function QueueControls({
  me,
  pending,
  mmr,
  setMmr,
  mmrHint,
  signupMmr,
  act,
  nextGame = false,
}: QueueControlProps) {
  const mmrInputId = useId();

  return (
    <div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        {!me.isLoggedIn ? (
          <a
            href="/login?next=/inhouse"
            className={buttonClasses("primary", "lg")}
          >
            {nextGame ? "Sign in for next game" : "Sign in to queue"}
          </a>
        ) : me.inQueue ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => act({ action: "leave" })}
            className={buttonClasses("secondary", "lg")}
          >
            Leave queue
          </button>
        ) : signupMmr > 0 ? (
          // joinQueue always uses the league signup MMR when there is one,
          // so an input here would be a control that does nothing.
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => act({ action: "join", mmr })}
              className={buttonClasses("accent", "lg")}
            >
              {nextGame ? "Join next-game queue →" : "Join queue →"}
            </button>
            <p className="text-center text-xs text-muted">
              Joining at{" "}
              <span className="tabular-nums text-fg">
                {signupMmr.toLocaleString()}
              </span>{" "}
              MMR, from your league signup
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-center gap-2">
            <label htmlFor={mmrInputId} className="text-sm text-muted">
              MMR
            </label>
            <input
              id={mmrInputId}
              type="number"
              min={0}
              max={12000}
              inputMode="numeric"
              value={mmr || ""}
              placeholder="0"
              onChange={(e) => setMmr(Number(e.target.value))}
              title="Seeds captain selection and the balance meter."
              className="h-11 w-24 rounded-lg border border-line bg-surface-2/50 px-3 text-center text-sm outline-none focus:border-accent/60"
            />
            <button
              type="button"
              disabled={pending}
              onClick={() => act({ action: "join", mmr })}
              className={buttonClasses("accent", "lg")}
            >
              {nextGame ? "Join next-game queue →" : "Join queue →"}
            </button>
          </div>
        )}
      </div>

      {/* Stays visible after joining — it's the explanation for why the listed
          MMR can differ from what was typed. */}
      {mmrHint ? (
        <details className="mt-3 text-center text-xs text-muted">
          <summary className="inline-flex min-h-8 cursor-pointer items-center rounded px-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
            How your MMR is set
          </summary>
          <p className="mt-1 text-left leading-relaxed">{mmrHint}</p>
        </details>
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
            This lobby is already underway. The next ready check can only start
            after it closes.
          </p>
        </div>
        <div className="shrink-0">
          <QueueControls
            me={state.me}
            pending={pending}
            mmr={mmr}
            setMmr={setMmr}
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
  mmrHint: string | null;
  signupMmr: number;
  firstGame: boolean;
  act: (body: Record<string, unknown>) => void;
  /** The visible queue will not form until the active lobby closes. */
  nextGame?: boolean;
}) {
  const { queue, lobbySize, needed, me } = state;
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

  const myPosition = present.findIndex((q) => q.userId === me.userId) + 1;

  const controls = (
    <QueueControls
      me={me}
      pending={pending}
      mmr={mmr}
      setMmr={setMmr}
      mmrHint={mmrHint}
      signupMmr={signupMmr}
      act={act}
      nextGame={nextGame}
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
        <section
          aria-label={nextGame ? "Next-game queue" : "Inhouse queue"}
          className="overflow-hidden rounded-2xl border border-accent/25 bg-surface/90 shadow-xl shadow-black/10"
        >
          <div className="grid lg:grid-cols-[0.85fr_1.35fr]">
            <div className="relative overflow-hidden border-b border-line bg-[radial-gradient(ellipse_at_top_left,color-mix(in_srgb,var(--color-accent)_12%,transparent),transparent_75%)] p-5 lg:border-b-0 lg:border-r lg:p-6">
              <div className="flex items-center gap-5 lg:flex-col lg:gap-3 lg:text-center">
                <div className="relative grid h-32 w-32 shrink-0 place-items-center lg:h-40 lg:w-40">
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
                      className="text-line"
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
                      className="text-accent transition-[stroke-dasharray] duration-500 motion-reduce:transition-none"
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
                    <span className="block font-display text-4xl font-bold leading-none tabular-nums lg:text-5xl">
                      {present.length}
                    </span>
                    <span className="mt-1 block text-[11px] text-muted">
                      of {lobbySize} players
                    </span>
                  </div>
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">
                    {nextGame ? "Up next" : "Pick-up Dota"}
                  </p>
                  <h2 className="mt-1 font-display text-2xl font-semibold tracking-tight">
                    {nextGame ? "Next-game queue" : "Inhouse queue"}
                  </h2>
                  <p className="mt-1.5 text-sm text-muted">
                    {needed > 0
                      ? `${needed} more ${needed === 1 ? "player" : "players"} to play`
                      : nextGame
                        ? "Full · waiting for this game to finish"
                        : "Full · starting the ready check…"}
                  </p>
                  {queueAvg > 0 ? (
                    <p className="mt-2 text-xs tabular-nums text-muted">
                      {queueAvg.toLocaleString()} average MMR
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="mt-5">{controls}</div>
              {me.inQueue ? (
                <p
                  role="status"
                  className="mt-3 text-center text-xs text-success"
                >
                  {myPosition > 0
                    ? `You’re #${myPosition} in line`
                    : "Your spot is saved"}
                  {nextGame ? " · next game" : " · listen for the ready check"}
                </p>
              ) : null}
            </div>

            <div className="min-w-0 p-4 sm:p-5">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">Who’s playing</h3>
                <span className="text-xs text-muted">
                  {nextGame ? (
                    "Ready check after this game"
                  ) : (
                    <>First {lobbySize} in → ready check</>
                  )}
                </span>
              </div>
              <ul className="grid grid-cols-2 gap-2">
                {slots.map((q, i) => {
                  if (!q) {
                    return (
                      <li
                        key={`open-${i}`}
                        className="flex min-h-16 items-center gap-2 rounded-xl border border-dashed border-line/70 px-3 py-2"
                      >
                        <span
                          aria-hidden
                          className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-dashed border-line text-sm text-muted"
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
                        "flex min-h-16 min-w-0 items-center gap-2 rounded-xl border px-2.5 py-2 transition-colors",
                        isMe
                          ? "border-accent/50 bg-accent/10"
                          : "border-line bg-surface-2/50",
                      )}
                    >
                      <Avatar name={q.name} src={q.avatar} size={30} />
                      <div className="min-w-0 flex-1">
                        <PlayerLink
                          userId={q.userId}
                          className="block truncate text-xs font-semibold sm:text-sm"
                        >
                          {q.name}
                        </PlayerLink>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
                          <span className="tabular-nums">#{i + 1}</span>
                          {isMe ? (
                            <span className="text-accent">You</span>
                          ) : null}
                          {q.mmr > 0 ? (
                            <span className="tabular-nums">
                              {q.mmr.toLocaleString()} MMR
                            </span>
                          ) : null}
                        </span>
                      </div>
                      <span className="hidden xl:block">
                        <RankBadge rankTier={q.rankTier} />
                      </span>
                    </li>
                  );
                })}
              </ul>
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
      <p className="px-1 text-center text-xs text-muted">
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
      className="rounded-2xl border border-accent/25 bg-surface/90 p-5 shadow-xl shadow-black/10 sm:p-6"
    >
      <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">
            {nextGame ? "Up next" : "Pick-up Dota"}
          </p>
          <h2 className="mt-1 font-display text-2xl font-semibold tracking-tight">
            {nextGame ? "Next-game queue" : "Inhouse queue"}
          </h2>
          <p className="mt-1.5 max-w-xl text-sm text-muted">
            {lobbySize} players queue up, vote on captains, draft two teams and
            play one game of Dota. The result records itself and moves
            everyone&apos;s Elo.
          </p>
        </div>
        <div className="shrink-0">{controls}</div>
      </div>
      <div className="mt-5 flex items-center gap-3">
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
