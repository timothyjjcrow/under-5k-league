"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  cancelReschedule,
  lockInReschedule,
  respondReschedule,
  voteReschedule,
  type ReadyCheckActionResult,
} from "@/app/actions/reschedule";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LocalTime, useLocalTimeText } from "@/components/local-time";
import { pushToast } from "@/components/toaster";
import { Avatar, buttonClasses } from "@/components/ui";
import { MATCH_ANCHOR } from "@/lib/match-anchors";
import {
  lockOffered,
  withMyAnswer,
  type ReadyAnswer,
  type ReadyCheckOptionView,
  type ReadyCheckSideView,
  type ReadyCheckView,
} from "@/lib/reschedule-ready-check";
import { cn } from "@/lib/utils";
import { ProposeTimes, type ProposeTimesProps } from "./propose-times";
import { TimeStack, type TimeParts } from "./time-chip";

const POLL_MS = 15_000;
const POLL_TIMEOUT_MS = 8_000;

/**
 * The reschedule ready check, live. Everyone playing the match answers each
 * offered time with one tap; their side's pips fill in as answers land (the
 * card polls GET /api/reschedule while its tab is visible). Captains get
 * "Lock it in" once the other captain has said yes, the opposing captain can
 * decline or counter with other times, and the proposer can withdraw. When a
 * time locks in, the page re-renders with LockedInCard in this card's place.
 *
 * Server-rendered times come in as `timeParts` (each time's day/date/time in
 * the server's zone) so hydration matches; the browser then shows them on
 * the viewer's own clock.
 */
export function ReadyCheckCard({
  initialView,
  timeParts,
  kickoffLabel,
  composer,
}: {
  initialView: ReadyCheckView;
  timeParts: Record<string, TimeParts>;
  /** Server "full" label of the current kickoff (LocalTime's snapshot). */
  kickoffLabel: string | null;
  /** The propose form's settings, for captains (a counter-proposal). */
  composer: ProposeTimesProps | null;
}) {
  const router = useRouter();
  const [view, setView] = useState(initialView);
  // A server re-render (after any action elsewhere on the page) hands down a
  // fresh view: adopt it.
  const [seenInitial, setSeenInitial] = useState(initialView);
  const [countering, setCountering] = useState(false);
  if (seenInitial !== initialView) {
    setSeenInitial(initialView);
    setView(initialView);
    // A counter-offer just replaced the ready check: close its form.
    if (seenInitial.requestId !== initialView.requestId) setCountering(false);
  }
  const [busy, setBusy] = useState<number | null>(null);
  const busyRef = useRef(false);
  // Bumped as each of the viewer's answers settles: a poll sent before the
  // latest one carries an older card and is dropped.
  const answersRef = useRef(0);

  // Poll while the ready check can still settle and this tab is on screen.
  // Spectators never poll: their strip is static.
  const pollable = view.open && view.viewer.kind !== "spectator";
  const matchId = view.matchId;
  const requestId = view.requestId;
  useEffect(() => {
    if (!pollable) return;
    let stopped = false;
    const tick = async () => {
      if (stopped || busyRef.current || document.visibilityState !== "visible")
        return;
      const answersAtSend = answersRef.current;
      try {
        const res = await fetch(
          `/api/reschedule?match=${encodeURIComponent(matchId)}`,
          { cache: "no-store", signal: AbortSignal.timeout(POLL_TIMEOUT_MS) },
        );
        if (!res.ok || stopped || busyRef.current) return;
        const body = (await res.json()) as { view?: ReadyCheckView | null };
        if (stopped || busyRef.current || answersRef.current !== answersAtSend)
          return;
        if (!body.view || body.view.requestId !== requestId) {
          // Locked in, withdrawn or replaced elsewhere: the page has news.
          stopped = true;
          router.refresh();
          return;
        }
        setView(body.view);
      } catch {
        // A missed poll is harmless; the next one tries again.
      }
    };
    const id = window.setInterval(tick, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pollable, matchId, requestId, router]);

  const answer = async (timeMs: number, ready: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(timeMs);
    const before = view;
    setView(withMyAnswer(view, timeMs, ready ? "ready" : "out"));
    let result: ReadyCheckActionResult;
    try {
      result = await voteReschedule({ matchId, requestId, timeMs, ready });
    } catch {
      // The answer may have landed; the page's next read will say. Never
      // show it as failed.
      busyRef.current = false;
      answersRef.current += 1;
      setBusy(null);
      pushToast(
        "info",
        "We couldn't confirm your answer — reloading to check where it stands.",
      );
      router.refresh();
      return;
    }
    busyRef.current = false;
    answersRef.current += 1;
    setBusy(null);
    if (result.error) {
      setView(before);
      pushToast("error", result.error);
      return;
    }
    if (result.locked) {
      // The action re-rendered the page: the "Locked in!" card replaces this
      // one. Refresh as well in case that render was lost in transit.
      if (result.message) pushToast("success", result.message);
      router.refresh();
      return;
    }
    if (result.message) pushToast("info", result.message);
    if (result.view === null) {
      router.refresh();
      return;
    }
    if (result.view) setView(result.view);
    // A captain's "Waiting on you" list sits outside this card and was
    // rendered with the page: refresh it, or "Answer the ready check" stays
    // up after they have.
    if (view.viewer.kind === "captain") router.refresh();
  };

  const { viewer } = view;
  const isCaptain = viewer.kind === "captain";
  const opposingCaptain = isCaptain && !viewer.isProposer;
  const answered = view.options.filter((o) => o.myAnswer !== null).length;
  const live = view.options.filter((o) => !o.passed);

  return (
    <div
      id={MATCH_ANCHOR.reschedule}
      className="relative min-w-0 scroll-mt-24 overflow-hidden rounded-[var(--radius)] border border-accent/40 bg-gradient-to-br from-accent/15 via-surface to-surface"
    >
      <div className="space-y-4 p-4 sm:p-5">
        <header className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
            <span aria-hidden>⏳ </span>Reschedule · ready check
          </p>
          <h3 className="font-display text-xl font-semibold leading-snug text-fg [overflow-wrap:anywhere]">
            {headline(view, answered)}
          </h3>
          <p className="text-sm text-muted [overflow-wrap:anywhere]">
            {viewer.isProposer ? "You" : <strong className="text-fg">{view.proposer.name}</strong>}{" "}
            {viewer.isProposer ? "want" : "wants"} to move {view.home.name} vs{" "}
            {view.away.name}
            {view.kickoffMs != null ? (
              <>
                {" "}from{" "}
                <span className="whitespace-nowrap text-fg line-through decoration-muted/70">
                  <LocalTime
                    ts={view.kickoffMs}
                    variant="full"
                    initial={kickoffLabel ?? ""}
                  />
                </span>
              </>
            ) : null}
            .
          </p>
          {view.note ? (
            <blockquote className="mt-2 rounded-lg rounded-tl-none border border-line bg-surface-2/60 px-3 py-2 text-sm text-fg [overflow-wrap:anywhere]">
              <span aria-hidden className="mr-1 text-muted">
                “
              </span>
              {view.note}
              <span aria-hidden className="ml-0.5 text-muted">
                ”
              </span>
            </blockquote>
          ) : null}
        </header>

        {!view.open ? (
          <p className="rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-sm text-muted">
            This match can&apos;t be moved any more, so the ready check is
            closed.
          </p>
        ) : null}

        <ol className="space-y-3">
          {view.options.map((option) => (
            <OptionCard
              key={option.timeMs}
              option={option}
              view={view}
              parts={timeParts[String(option.timeMs)]}
              busy={busy === option.timeMs}
              locked={busy !== null}
              onAnswer={(ready) => void answer(option.timeMs, ready)}
            />
          ))}
        </ol>

        {view.open && live.length === 0 ? (
          <p className="text-sm text-muted">
            Every time on offer has passed. A captain can suggest new ones.
          </p>
        ) : null}

        {isCaptain && view.open ? (
          <div className="space-y-3 border-t border-line pt-4">
            {countering && composer ? (
              <div className="space-y-3">
                <p className="text-sm font-semibold text-fg">
                  {viewer.isProposer ? "Change your times" : "Suggest other times"}
                </p>
                <p className="text-xs text-muted">
                  Sending replaces this ready check; everyone answers again.
                </p>
                <ProposeTimes
                  {...composer}
                  submitLabel={
                    viewer.isProposer ? "Send new times" : "Send counter-offer"
                  }
                  onCancel={() => setCountering(false)}
                />
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                {composer ? (
                  <button
                    type="button"
                    onClick={() => setCountering(true)}
                    className={buttonClasses("secondary", "sm")}
                  >
                    {viewer.isProposer ? "Change times" : "Suggest other times"}
                  </button>
                ) : null}
                {viewer.isProposer ? (
                  <ActionForm
                    action={cancelReschedule}
                    hidden={{ requestId: view.requestId }}
                  >
                    <SubmitButton
                      variant="ghost"
                      size="sm"
                      confirm="Withdraw this ready check? The current kickoff stays."
                    >
                      Withdraw
                    </SubmitButton>
                  </ActionForm>
                ) : null}
                {opposingCaptain ? (
                  <ActionForm
                    action={respondReschedule}
                    hidden={{ requestId: view.requestId, response: "decline" }}
                  >
                    <SubmitButton
                      variant="ghost"
                      size="sm"
                      confirm={`Decline every time ${view.proposer.name} offered? The current kickoff stays, and they're told.`}
                    >
                      None of these work
                    </SubmitButton>
                  </ActionForm>
                ) : null}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function headline(view: ReadyCheckView, answered: number): string {
  const { viewer } = view;
  const n = view.options.length;
  if (!view.open) return "Ready check closed";
  if (viewer.isProposer) return "Ready check sent — waiting on everyone else";
  if (!viewer.canAnswer)
    return n === 1
      ? "The captains are agreeing a new time"
      : `The captains are agreeing a new time (${n} options)`;
  if (answered === 0)
    return n === 1 ? "Can you make the new time?" : `Can you make any of these ${n} times?`;
  if (answered < n) return "Thanks — answer the rest too";
  return "You're answered — waiting on the others";
}

function OptionCard({
  option,
  view,
  parts,
  busy,
  locked,
  onAnswer,
}: {
  option: ReadyCheckOptionView;
  view: ReadyCheckView;
  parts: TimeParts | undefined;
  busy: boolean;
  locked: boolean;
  onAnswer: (ready: boolean) => void;
}) {
  const fallback = parts ?? { day: "", date: "", time: "" };
  const confirmTime = useLocalTimeText(
    option.timeMs,
    "full",
    `${fallback.day}, ${fallback.date}, ${fallback.time}`,
  );
  const canAnswer = view.viewer.canAnswer && !option.passed;
  const isCaptain = view.viewer.kind === "captain";
  const showLock = isCaptain && lockOffered(option);
  const stuck = view.open && option.everyoneIn && !option.passed;
  const notReady = option.seatTotal - option.readyTotal;
  const pct = option.seatTotal
    ? Math.round((option.readyTotal / option.seatTotal) * 100)
    : 0;

  return (
    <li
      className={cn(
        "min-w-0 rounded-xl border bg-surface/80 p-3 sm:p-4",
        option.everyoneIn
          ? "border-success/60"
          : option.leading
            ? "border-accent/60"
            : "border-line",
        option.passed && "opacity-60",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <TimeStack ts={option.timeMs} initial={fallback} size="lg" />
        <div className="flex flex-wrap items-center gap-1.5">
          {option.passed ? (
            <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted">
              Passed
            </span>
          ) : option.everyoneIn ? (
            <span className="rounded-full border border-success/40 bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
              ✓ Everyone&apos;s in
            </span>
          ) : option.leading ? (
            <span className="rounded-full border border-accent/40 bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
              ★ Most ready
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-3 space-y-2">
        <SideRow side={option.home} captain={option.captains.home} named={view.named} />
        <SideRow side={option.away} captain={option.captains.away} named={view.named} />
      </div>

      <div className="mt-3">
        <div
          role="img"
          aria-label={`${option.readyTotal} of ${option.seatTotal} players ready`}
          className="h-1.5 overflow-hidden rounded-full bg-line"
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none",
              option.everyoneIn ? "bg-success" : "bg-accent",
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-1.5 text-xs text-muted [overflow-wrap:anywhere]">
          <span className="tabular-nums text-fg">
            {option.readyTotal}/{option.seatTotal}
          </span>{" "}
          ready · {option.statusLine}
        </p>
        {stuck ? (
          <p className="mt-1 text-xs text-accent [overflow-wrap:anywhere]">
            {isCaptain
              ? "The match hasn't moved to this time yet. Lock it in to move it."
              : "The match hasn't moved to this time yet: a captain can lock it in."}
          </p>
        ) : null}
      </div>

      {canAnswer || showLock ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {canAnswer ? (
            <div
              role="group"
              aria-label="Can you make this time?"
              className="grid min-w-0 flex-1 grid-cols-2 gap-2 sm:flex-none"
            >
              <button
                type="button"
                aria-pressed={option.myAnswer === "ready"}
                disabled={locked}
                onClick={() => onAnswer(true)}
                className={cn(
                  buttonClasses(
                    option.myAnswer === "ready" ? "primary" : "secondary",
                    "sm",
                  ),
                  option.myAnswer === "ready" &&
                    "bg-success text-black hover:bg-success/90",
                  "px-3 sm:px-4",
                )}
              >
                {busy && option.myAnswer === "ready" ? "…" : "✓ I'm in"}
              </button>
              <button
                type="button"
                aria-pressed={option.myAnswer === "out"}
                disabled={locked}
                onClick={() => onAnswer(false)}
                className={cn(
                  buttonClasses(
                    option.myAnswer === "out" ? "danger" : "secondary",
                    "sm",
                  ),
                  "px-3 sm:px-4",
                )}
              >
                {busy && option.myAnswer === "out" ? "…" : "✗ Can't"}
              </button>
            </div>
          ) : null}
          {showLock ? (
            <ActionForm
              action={lockInReschedule}
              hidden={{
                requestId: view.requestId,
                optionTs: String(option.timeMs),
              }}
              className="w-full sm:ml-auto sm:w-auto"
            >
              <SubmitButton
                variant="accent"
                size="sm"
                className="w-full sm:w-auto"
                confirm={lockConfirm(confirmTime, option, notReady)}
              >
                {view.viewer.isProposer ? "🔒 Lock it in" : "🔒 Accept & lock in"}
              </SubmitButton>
            </ActionForm>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function lockConfirm(
  when: string,
  option: ReadyCheckOptionView,
  notReady: number,
): string {
  const out = option.home.out + option.away.out;
  const waiting = option.home.pending + option.away.pending;
  const gaps = [
    out ? `${out} can't make it` : null,
    waiting ? `${waiting} haven't answered` : null,
  ].filter(Boolean);
  return (
    `Move the match to ${when}?` +
    (notReady > 0 && gaps.length
      ? ` Not everyone is in yet: ${gaps.join(" and ")}.`
      : "") +
    " Everyone's answer becomes their check-in for the new time."
  );
}

const ANSWER_STYLE: Record<"ready" | "out" | "waiting", string> = {
  ready: "border-success bg-success text-black",
  out: "border-danger bg-danger/20 text-danger-soft",
  waiting: "border-dashed border-muted/60 bg-transparent text-muted",
};

function answerWord(answer: ReadyAnswer): string {
  return answer === "ready" ? "in" : answer === "out" ? "can't make it" : "hasn't answered";
}

function SideRow({
  side,
  captain,
  named,
}: {
  side: ReadyCheckSideView;
  captain: ReadyAnswer;
  named: boolean;
}) {
  const waiting = side.seats.filter((s) => s.answer === null);
  // Before anyone on the side answers, one line says so instead of a roll call.
  const nobodyYet = named && waiting.length > 0 && waiting.length === side.seats.length;
  const waitingNames = named && !nobodyYet ? waiting.map((s) => s.name) : [];
  const outNames = named
    ? side.seats.filter((s) => s.answer === "out").map((s) => s.name)
    : [];
  return (
    <div className="min-w-0">
      {/* Phones: name, count and captain on one line, the pips below it.
          Wider: name, pips, count, captain in one row. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        <span
          className="min-w-0 flex-1 truncate text-sm font-medium text-fg sm:w-32 sm:flex-none"
          title={side.name}
        >
          {side.name}
        </span>
        <ul
          aria-label={`${side.name}: ${side.ready} in, ${side.out} can't, ${side.pending} waiting`}
          className="order-last flex w-full min-w-0 flex-wrap items-center gap-1 sm:order-none sm:w-auto sm:flex-1"
        >
          {side.seats.map((seat, i) => {
            const key = seat.answer ?? "waiting";
            const label = seat.name
              ? `${seat.me ? "You" : seat.name}: ${answerWord(seat.answer)}`
              : `A player: ${answerWord(seat.answer)}`;
            return (
              <li key={seat.userId ?? `${key}-${i}`} title={label}>
                {seat.name ? (
                  <span
                    role="img"
                    aria-label={label}
                    className={cn(
                      "block rounded-full ring-2",
                      seat.answer === "ready"
                        ? "ready-pop ring-success"
                        : seat.answer === "out"
                          ? "ring-danger opacity-70"
                          : "opacity-50 ring-line grayscale",
                      seat.me && "ring-offset-2 ring-offset-surface",
                    )}
                  >
                    <Avatar name={seat.name} src={seat.avatar} size={22} />
                  </span>
                ) : (
                  <span
                    role="img"
                    aria-label={label}
                    className={cn(
                      "flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 text-xs font-bold",
                      ANSWER_STYLE[key],
                      seat.answer === "ready" && "ready-pop",
                    )}
                  >
                    <span aria-hidden>
                      {seat.answer === "ready" ? "✓" : seat.answer === "out" ? "✗" : ""}
                    </span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        <span className="shrink-0 text-xs tabular-nums text-muted">
          {side.ready}/{side.need || side.seats.length}
        </span>
        <span
          role="img"
          aria-label={`Captain ${answerWord(captain)}`}
          title={`Captain ${answerWord(captain)}`}
          className={cn(
            "shrink-0 rounded-full border px-1.5 text-xs font-semibold",
            captain === "ready"
              ? "border-success/50 bg-success/15 text-success"
              : captain === "out"
                ? "border-danger/50 bg-danger/15 text-danger-soft"
                : "border-line text-muted",
          )}
        >
          C{captain === "ready" ? " ✓" : captain === "out" ? " ✗" : ""}
        </span>
      </div>
      {nobodyYet ? (
        <p className="mt-1 text-xs text-muted sm:pl-34">No answers yet</p>
      ) : waitingNames.length || outNames.length ? (
        <p className="mt-1 text-xs text-muted [overflow-wrap:anywhere] sm:pl-34">
          {outNames.length ? (
            <span className="text-danger-soft">Can&apos;t: {outNames.join(", ")}</span>
          ) : null}
          {outNames.length && waitingNames.length ? " · " : null}
          {waitingNames.length ? <span>Waiting on {waitingNames.join(", ")}</span> : null}
        </p>
      ) : null}
    </div>
  );
}
