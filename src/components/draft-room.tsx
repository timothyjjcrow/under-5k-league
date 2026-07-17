"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Avatar,
  Badge,
  HeroList,
  PlayerLink,
  RankBadge,
  RoleBadges,
  TeamCrest,
  buttonClasses,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { pushToast } from "@/components/toaster";
import { Countdown } from "@/components/countdown";
import { DiscordTag } from "@/components/discord-tag";
import { playChime, unlockAudio } from "@/components/chime";
import {
  useBannerOffscreen,
  usePollHealth,
  useSecondsLeft,
} from "@/components/room-clock";
import { DOTA_ROLES } from "@/lib/roles";
import { maxBid, wasOutbid } from "@/lib/draft";
import { DEFAULTS } from "@/lib/constants";
import { filterAndSortPlayers, type PoolSort } from "@/lib/player-pool";
import type { DraftState } from "@/lib/draft-service";

// A single line in the live feed, derived purely from state transitions.
type FeedEvent = {
  id: number;
  kind: "nominate" | "bid" | "sold";
  text: string;
  amount: number;
};

// --- Countdown leaves -------------------------------------------------------
// These own the 250ms tick via useSecondsLeft, so only the clock text
// re-renders each second — the room + player pool no longer do. Markup matches
// the originals exactly.

// Compact clock for the sticky bar that pins under the header.
function CompactClock({
  endsAtMs,
  offsetMs,
  urgentAt,
  calmTone,
}: {
  endsAtMs: number | null;
  offsetMs: number;
  urgentAt: number;
  calmTone: string;
}) {
  const seconds = useSecondsLeft(endsAtMs, offsetMs);
  return (
    <span
      className={cn(
        "shrink-0 font-mono text-lg font-bold tabular-nums",
        seconds <= urgentAt ? "text-danger" : calmTone,
      )}
    >
      {seconds}s
    </span>
  );
}

// The big bid clock in the "on the block" banner (ping dot under 5s).
function BidClock({
  endsAtMs,
  offsetMs,
}: {
  endsAtMs: number | null;
  offsetMs: number;
}) {
  const seconds = useSecondsLeft(endsAtMs, offsetMs);
  return (
    <div
      role="timer"
      aria-label={`${seconds} seconds left on the bid clock`}
      className={cn(
        "flex items-center gap-2 font-mono text-2xl font-bold tabular-nums",
        seconds <= 5 ? "text-danger" : "text-accent",
      )}
    >
      {seconds <= 5 ? (
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger" />
        </span>
      ) : null}
      <span className={seconds <= 5 ? "animate-countdown-urgent" : ""}>
        {seconds}s
      </span>
    </div>
  );
}

// The big nomination clock in the banner (auto-skip warning under 10s).
function NomClock({
  endsAtMs,
  offsetMs,
}: {
  endsAtMs: number | null;
  offsetMs: number;
}) {
  const seconds = useSecondsLeft(endsAtMs, offsetMs);
  return (
    <div
      role="timer"
      aria-label={`${seconds} seconds left to nominate`}
      className={cn(
        "flex items-center gap-2 font-mono text-2xl font-bold tabular-nums",
        seconds <= 10 ? "text-danger" : "text-muted",
      )}
    >
      <span className={seconds <= 10 ? "animate-countdown-urgent" : ""}>
        {seconds}s
      </span>
    </div>
  );
}

export function DraftRoom({
  pollMs = 1200,
  draftAtMs = null,
}: {
  pollMs?: number;
  /** Scheduled draft night (server-passed) — shown in the waiting room. */
  draftAtMs?: number | null;
}) {
  const [state, setState] = useState<DraftState | null>(null);
  const { disconnected, ok: pollOk, fail: pollFail } = usePollHealth();
  // While there's no active season the tick 404s forever — terminal state.
  const [noSeason, setNoSeason] = useState(false);
  const [reqPending, setPending] = useState(false);
  // Disconnected = every action disabled: a bid against stale state would
  // either fail or, worse, look accepted while the real auction moved on.
  const pending = reqPending || disconnected;
  const [soundOn, setSoundOn] = useState(true);
  // Latched while the viewer's team has lost the high bid on the live
  // nomination — cleared by the poll once it's stale (re-took the bid, the
  // player sold, or bidding closed).
  const [outbid, setOutbid] = useState<{
    player: string;
    team: string;
    amount: number;
  } | null>(null);
  const offsetRef = useRef(0); // serverNow - clientNow, to sync the countdown
  const [selected, setSelected] = useState<string | null>(null);
  const [nomAmount, setNomAmount] = useState(1);
  // Live feed + "SOLD!" flash — derived client-side by diffing successive
  // polled states, so no changes to the server-authoritative draft engine.
  const prevRef = useRef<DraftState | null>(null);
  const eventIdRef = useRef(0);
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [soldFlash, setSoldFlash] = useState<{
    name: string;
    team: string;
    price: number;
    /** The viewer themself was just sold — their personal draft moment. */
    isMe: boolean;
  } | null>(null);

  useEffect(() => {
    setSoundOn(localStorage.getItem("draftSound") !== "off");
  }, []);

  const toggleSound = useCallback(() => {
    setSoundOn((on) => {
      const next = !on;
      localStorage.setItem("draftSound", next ? "on" : "off");
      if (next) playChime(); // confirm + unlock audio on this gesture
      return next;
    });
  }, []);

  const apply = useCallback((s: DraftState) => {
    offsetRef.current = s.now - Date.now();
    setState(s);
  }, []);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/draft/tick", { method: "POST" });
      if (res.ok) {
        apply(await res.json());
        pollOk();
      } else if (res.status === 404) {
        setNoSeason(true); // season deactivated under us — stop pretending
      } else {
        pollFail();
      }
    } catch {
      pollFail(); // network blip; next poll retries
    }
  }, [apply, pollOk, pollFail]);

  useEffect(() => {
    poll();
    const id = setInterval(poll, pollMs);
    return () => clearInterval(id);
  }, [poll, pollMs]);

  // Diff each new state against the previous one to build the live feed +
  // trigger the SOLD! flash. Read-only — never mutates draft state.
  useEffect(() => {
    if (!state) return;
    const prev = prevRef.current;
    prevRef.current = state;
    const nameOf = (id: string | null) =>
      state.teams.find((t) => t.id === id)?.name ?? "—";
    if (!prev) {
      // First state after a page load: seed the feed with the reconstructed
      // history (current nomination + past sales) so joining mid-draft
      // doesn't mean an empty feed.
      const seed: FeedEvent[] = [];
      if (state.nominatedPlayer) {
        seed.push({
          id: eventIdRef.current++,
          kind: "nominate",
          text: `${nameOf(state.nominatorTeamId)} nominated ${state.nominatedPlayer.name}`,
          amount: state.currentBid,
        });
      }
      for (const s of state.recentSales) {
        seed.push({
          id: eventIdRef.current++,
          kind: "sold",
          text: `${s.name} → ${s.teamName}`,
          amount: s.price,
        });
      }
      if (seed.length) setEvents(seed.slice(0, 12));
      return;
    }
    const add: FeedEvent[] = [];

    // A sale = any new non-captain roster member appearing on a team.
    const prevRostered = new Set(
      prev.teams.flatMap((t) => t.members.map((m) => m.userId)),
    );
    for (const t of state.teams) {
      for (const m of t.members) {
        if (!m.isCaptain && !prevRostered.has(m.userId)) {
          add.push({
            id: eventIdRef.current++,
            kind: "sold",
            text: `${m.name} → ${t.name}`,
            amount: m.price,
          });
          const isMe = !!state.me.userId && m.userId === state.me.userId;
          setSoldFlash({ name: m.name, team: t.name, price: m.price, isMe });
          if (isMe && soundOn) playChime(); // your personal draft moment
        }
      }
    }

    const prevNom = prev.nominatedPlayer?.userId ?? null;
    const curNom = state.nominatedPlayer?.userId ?? null;
    // YOU just went on the block — worth a bell even for non-captains.
    if (curNom && curNom !== prevNom && curNom === state.me.userId && soundOn) {
      playChime();
    }
    if (curNom && curNom !== prevNom) {
      add.push({
        id: eventIdRef.current++,
        kind: "nominate",
        text: `${nameOf(state.nominatorTeamId)} nominated ${state.nominatedPlayer!.name}`,
        amount: state.currentBid,
      });
    } else if (curNom && curNom === prevNom && state.currentBid > prev.currentBid) {
      add.push({
        id: eventIdRef.current++,
        kind: "bid",
        text: `${nameOf(state.currentBidTeamId)} bid`,
        amount: state.currentBid,
      });
    }

    if (add.length) setEvents((e) => [...add, ...e].slice(0, 12));

    // Outbid latch: clear stale first, then a fresh detection wins the tick.
    const myTeamId = state.me.myTeamId;
    if (
      (myTeamId && state.currentBidTeamId === myTeamId) ||
      curNom !== prevNom ||
      !curNom ||
      !state.me.canBid
    ) {
      setOutbid(null);
    }
    if (
      wasOutbid({
        myTeamId,
        prevBidTeamId: prev.currentBidTeamId,
        curBidTeamId: state.currentBidTeamId,
        prevNominatedId: prevNom,
        curNominatedId: curNom,
      })
    ) {
      setOutbid({
        player: state.nominatedPlayer!.name,
        team: nameOf(state.currentBidTeamId),
        amount: state.currentBid,
      });
      if (soundOn) playChime();
    }

    // Your turn to nominate — the moment auto-skip punishes hardest.
    if (state.me.canNominate && !prev.me.canNominate && soundOn) playChime();
  }, [state, soundOn]);

  useEffect(() => {
    if (!soldFlash) return;
    const id = setTimeout(() => setSoldFlash(null), 3600);
    return () => clearTimeout(id);
  }, [soldFlash]);

  // A captain tabbed away can miss their nomination window (auto-skip picks
  // for them) or lose a player to the 30s bid clock — flag both in the tab
  // title. The outbid prefix is latched on the actual outbid event, never on
  // merely "not holding the high bid" (that would mislabel every nomination
  // the captain never bid on).
  const myPick = !!state && state.status !== "COMPLETE" && state.me.canNominate;
  const titleFlag = myPick
    ? "⏰ Your pick — "
    : outbid
      ? "💸 Outbid — "
      : null;
  useEffect(() => {
    const PREFIXES = ["⏰ Your pick — ", "💸 Outbid — "];
    const strip = (t: string) => {
      for (const p of PREFIXES) if (t.startsWith(p)) return t.slice(p.length);
      return t;
    };
    const base = strip(document.title);
    document.title = titleFlag ? titleFlag + base : base;
    return () => {
      document.title = strip(document.title);
    };
  }, [titleFlag]);

  // The clock banner scrolls away while captains browse the pool — a compact
  // sticky bar takes over (shared hook; the inhouse room uses it too).
  const draftLive = !!state && state.status !== "COMPLETE";
  const { ref: bannerRef, offscreen: bannerOffscreen } =
    useBannerOffscreen(draftLive);

  async function act(url: string, body: Record<string, unknown>) {
    unlockAudio(); // this click is a user gesture — prime audio for later
    setPending(true);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        // Toast, not an inline banner: race rejections ("Another bid just
        // landed") arrive exactly while the captain is scrolled deep in the
        // pool, where a top-of-room banner is invisible — a silently lost
        // bid under a 30s clock. The global toaster is fixed-position.
        pushToast("error", data.error || "Action failed");
      } else {
        apply(data);
        setSelected(null);
      }
    } catch {
      pushToast("error", "Network error — that didn't go through");
    } finally {
      setPending(false);
    }
  }

  if (noSeason) {
    return (
      <div className="rounded-[var(--radius)] border border-line bg-surface/60 p-8 text-center">
        <div className="text-lg font-semibold">The draft isn&apos;t available</div>
        <p className="mt-1 text-sm text-muted">
          There&apos;s no active season right now.
        </p>
        <Link href="/" className={buttonClasses("secondary", "sm", "mt-4")}>
          Back to home
        </Link>
      </div>
    );
  }

  if (!state) {
    return <div className="py-10 text-center text-muted">Loading draft…</div>;
  }

  // Shared "polling is dead" strip — clocks below are ticking on stale state.
  const disconnectedStrip = disconnected ? (
    <div
      role="status"
      aria-live="polite"
      className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger"
    >
      ⚠️ Connection lost — reconnecting… The auction keeps running on the
      server; actions are paused until we&apos;re back.
    </div>
  ) : null;

  const { me } = state;
  // The countdowns tick inside <BidClock>/<NomClock> leaves (see below) so the
  // per-second update doesn't re-render the whole room + player pool.
  const offsetMs = offsetRef.current;
  const nominatorName =
    state.teams.find((t) => t.id === state.nominatorTeamId)?.name ?? "—";
  const highBidderName = state.teams.find(
    (t) => t.id === state.currentBidTeamId,
  )?.name;
  // The viewer's own team (if a captain) — drives the "why can't I bid" copy.
  const myTeam = me.myTeamId
    ? state.teams.find((t) => t.id === me.myTeamId)
    : undefined;
  const rosterFull = !!me.myTeamId && myTeam?.need === 0;
  const pricedOut =
    !!me.myTeamId && !rosterFull && me.myMaxBid <= state.currentBid;

  const quickBid = (delta: number) => {
    const amount = state.currentBid + delta;
    if (amount > me.myMaxBid) return;
    act("/api/draft/bid", { amount });
  };

  if (state.status === "NOT_STARTED") {
    // Waiting room, not a dead end: the poll flips this live the moment the
    // admin starts — nobody has to hand-refresh into a running clock. The
    // admin CTA renders only for admins (everyone else used to get bounced
    // off /admin with no explanation).
    return (
      <div className="space-y-6">
        {disconnectedStrip}
        <div className="rounded-[var(--radius)] border border-line bg-surface/60 p-6 text-center">
          <div className="text-2xl" aria-hidden>
            ⏳
          </div>
          <div className="mt-1 text-lg font-semibold">
            Waiting for the admin to start the auction
          </div>
          <div className="text-sm text-muted">
            This page goes live automatically — no need to refresh.
          </div>
          {draftAtMs ? (
            <div className="mt-2 text-sm text-muted">
              🗓️ Draft night:{" "}
              {/* Client component — this branch never SSRs (state loads via
                  poll first), so browser-local formatting can't mismatch. */}
              <strong className="text-fg">
                {new Date(draftAtMs).toLocaleString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </strong>
              <Countdown targetMs={draftAtMs} eventLabel="Draft" />
            </div>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <Link href="/players" className={buttonClasses("secondary", "sm")}>
              Scout the player pool
            </Link>
            <Link href="/teams" className={buttonClasses("secondary", "sm")}>
              Captains &amp; budgets
            </Link>
            {me.isAdmin ? (
              <Link href="/admin" className={buttonClasses("accent", "sm")}>
                Start it from the admin panel →
              </Link>
            ) : null}
          </div>
        </div>
        <AuctionPrimer
          minBid={state.minBid}
          teamSize={state.teamSize}
          defaultOpen
        />
        {state.teams.length > 0 ? <TeamsGrid state={state} /> : null}
      </div>
    );
  }

  if (state.status === "COMPLETE") {
    return (
      <div className="space-y-6">
        <div className="rounded-[var(--radius)] border border-success/40 bg-success/10 p-6 text-center">
          <div className="text-2xl">✅</div>
          <div className="mt-1 text-lg font-semibold">The draft is complete!</div>
          <div className="text-sm text-muted">
            All rosters are set. Standings and the schedule are next.
          </div>
        </div>
        <TeamsGrid state={state} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {disconnectedStrip}
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={toggleSound}
          aria-pressed={soundOn}
          title={
            soundOn
              ? "Notification sound on — click to mute"
              : "Notifications muted — click to enable a bell"
          }
          className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2/40 px-3 py-1 text-xs text-muted transition-colors hover:text-fg"
        >
          <span aria-hidden>{soundOn ? "🔔" : "🔕"}</span>
          {soundOn ? "Sound on" : "Muted"}
        </button>
      </div>

      {outbid ? (
        <div
          role="status"
          className="flex flex-col items-center gap-1 rounded-[var(--radius)] border border-danger/50 bg-gradient-to-r from-danger/15 via-danger/10 to-danger/15 px-5 py-3 text-center"
        >
          <div className="font-display text-lg font-black uppercase tracking-widest text-danger">
            💸 Outbid!
          </div>
          <div className="text-sm">
            <span className="font-semibold">{outbid.team}</span> bid $
            {outbid.amount} on <span className="font-semibold">{outbid.player}</span>
          </div>
          {state.me.canBid ? (
            <button
              type="button"
              onClick={() => quickBid(1)}
              disabled={pending || state.currentBid + 1 > me.myMaxBid}
              className={buttonClasses("accent", "sm", "mt-1")}
            >
              Re-bid ${state.currentBid + 1}
            </button>
          ) : null}
        </div>
      ) : null}

      {soldFlash ? (
        <div
          className={cn(
            "sold-flash flex flex-col items-center gap-1 rounded-[var(--radius)] border px-5 py-4 text-center",
            soldFlash.isMe
              ? "border-accent/60 bg-gradient-to-r from-accent/20 via-accent/10 to-accent/20"
              : "border-success/50 bg-gradient-to-r from-success/15 via-success/10 to-success/15",
          )}
        >
          <div
            className={cn(
              "font-display text-2xl font-black uppercase tracking-widest",
              soldFlash.isMe ? "text-accent" : "text-success",
            )}
          >
            {soldFlash.isMe ? "🎉 You're drafted!" : "Sold!"}
          </div>
          <div className="text-sm">
            {soldFlash.isMe ? (
              <>
                Welcome to <span className="font-semibold">{soldFlash.team}</span>{" "}
                — they paid{" "}
                <span className="font-bold text-accent">${soldFlash.price}</span>{" "}
                for you.
              </>
            ) : (
              <>
                <span className="font-semibold">{soldFlash.name}</span> →{" "}
                {soldFlash.team} for{" "}
                <span className="font-bold text-accent">${soldFlash.price}</span>
              </>
            )}
          </div>
        </div>
      ) : null}

      {/* Compact clock bar — pins under the site header while the captain is
          deep in the player pool, so the auction never disappears. */}
      {bannerOffscreen && (state.nominatedPlayer || state.nominationEndsAt) ? (
        // Outer element is a DIV so the action button can sit beside the
        // scroll-back button — interactive content nested inside a <button>
        // is invalid HTML (unreliable clicks, screen-reader breakage).
        <div className="fixed inset-x-0 top-20 z-20 border-b border-line bg-bg/90 backdrop-blur">
          <div className="mx-auto flex h-11 w-full max-w-6xl items-center gap-3 px-4 text-sm sm:px-6">
            <button
              type="button"
              onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
              aria-label="Back to the auction clock"
              className="flex h-full min-w-0 flex-1 items-center justify-between gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
            >
              {disconnected ? (
                <span className="shrink-0 text-xs font-medium text-danger">
                  ⚠ reconnecting…
                </span>
              ) : null}
              {state.nominatedPlayer ? (
                <>
                  <span className="flex min-w-0 items-center gap-2">
                    <span aria-hidden>🔨</span>
                    <span className="truncate font-medium">
                      {state.nominatedPlayer.name}
                    </span>
                    <span className="shrink-0 font-mono font-semibold text-accent">
                      ${state.currentBid}
                    </span>
                    {highBidderName ? (
                      <span className="hidden truncate text-muted sm:inline">
                        · {highBidderName}
                      </span>
                    ) : null}
                  </span>
                  <CompactClock
                    endsAtMs={state.bidEndsAt}
                    offsetMs={offsetMs}
                    urgentAt={5}
                    calmTone="text-accent"
                  />
                </>
              ) : (
                <>
                  <span className="min-w-0 truncate text-muted">
                    {nominatorName} to nominate…
                  </span>
                  <CompactClock
                    endsAtMs={state.nominationEndsAt}
                    offsetMs={offsetMs}
                    urgentAt={10}
                    calmTone="text-muted"
                  />
                </>
              )}
            </button>
            {/* Act from HERE: scrolling a full page up and re-orienting burns
                5-10s of a 30s bid clock — the dominant flow on phones where
                the pool is deliberately DOM-first. */}
            {state.nominatedPlayer && me.canBid ? (
              <button
                type="button"
                onClick={() => quickBid(1)}
                disabled={pending || state.currentBid + 1 > me.myMaxBid}
                className={buttonClasses("accent", "sm", "shrink-0")}
              >
                {outbid
                  ? `Re-bid $${state.currentBid + 1}`
                  : `Bid $${state.currentBid + 1}`}
              </button>
            ) : !state.nominatedPlayer && me.canNominate && selected ? (
              <button
                type="button"
                onClick={() =>
                  act("/api/draft/nominate", {
                    playerId: selected,
                    amount: nomAmount,
                  })
                }
                disabled={
                  pending || nomAmount < state.minBid || nomAmount > me.myMaxBid
                }
                className={buttonClasses("accent", "sm", "max-w-[14rem] shrink-0")}
              >
                <span className="truncate">
                  Nominate{" "}
                  {state.available.find((p) => p.userId === selected)?.name ??
                    ""}{" "}
                  · ${nomAmount}
                </span>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* On the block */}
      <div
        ref={bannerRef}
        className={cn(
          "rounded-[var(--radius)] border border-line bg-surface/80",
          // The viewer IS the player being auctioned — their moment glows.
          !!me.userId &&
            state.nominatedPlayer?.userId === me.userId &&
            "border-accent/70 ring-2 ring-accent/30",
          // Dim the (stale) clocks while polling is dead — they're ticking on
          // the last state we saw, not the live auction.
          disconnected && "opacity-50",
        )}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div className="text-sm text-muted">
            On the clock: <span className="text-fg">{nominatorName}</span>
          </div>
          {state.nominatedPlayer ? (
            <BidClock endsAtMs={state.bidEndsAt} offsetMs={offsetMs} />
          ) : state.nominationEndsAt ? (
            <NomClock endsAtMs={state.nominationEndsAt} offsetMs={offsetMs} />
          ) : null}
        </div>

        <div className="p-5">
          {state.nominatedPlayer ? (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Avatar
                  name={state.nominatedPlayer.name}
                  src={state.nominatedPlayer.avatar}
                  size={52}
                />
                <div>
                  <div className="flex flex-wrap items-center gap-2 text-xl font-bold">
                    {state.nominatedPlayer.name}
                    {me.userId === state.nominatedPlayer.userId ? (
                      <Badge tone="accent">You're on the block!</Badge>
                    ) : null}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted">
                    {state.nominatedPlayer.mmr > 0 ? (
                      <span>{state.nominatedPlayer.mmr} MMR</span>
                    ) : null}
                    <RankBadge rankTier={state.nominatedPlayer.rankTier} />
                    <RoleBadges roles={state.nominatedPlayer.roles} />
                    <DiscordTag name={state.nominatedPlayer.discordName} />
                    {/* Scouting links — open in a new tab so a captain can't
                        navigate away mid-auction. */}
                    <Link
                      href={`/players/${state.nominatedPlayer.userId}`}
                      target="_blank"
                      className="text-info hover:underline"
                    >
                      Profile ↗
                    </Link>
                    {state.nominatedPlayer.accountId ? (
                      <a
                        href={`https://www.dotabuff.com/players/${state.nominatedPlayer.accountId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-info hover:underline"
                      >
                        Dotabuff ↗
                      </a>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="text-right">
                <div className="text-3xl font-bold text-accent">
                  ${state.currentBid}
                </div>
                <div className="text-xs text-muted">
                  {highBidderName ? `high bid · ${highBidderName}` : "opening"}
                </div>
              </div>

              {state.nominatedPlayer.favoriteHeroes ||
              state.nominatedPlayer.statement ||
              state.nominatedPlayer.captainNote ? (
                <div className="w-full space-y-1 border-t border-line pt-3 text-sm">
                  {state.nominatedPlayer.favoriteHeroes ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-muted">Heroes:</span>
                      <HeroList
                        value={state.nominatedPlayer.favoriteHeroes}
                        size={30}
                      />
                    </div>
                  ) : null}
                  {state.nominatedPlayer.captainNote ? (
                    <div>
                      <span className="text-muted">Note to captains:</span>{" "}
                      {state.nominatedPlayer.captainNote}
                    </div>
                  ) : null}
                  {state.nominatedPlayer.statement ? (
                    <div className="text-muted">
                      &ldquo;{state.nominatedPlayer.statement}&rdquo;
                    </div>
                  ) : null}
                </div>
              ) : null}

              {me.canBid ? (
                <div className="flex w-full flex-wrap items-center gap-2 border-t border-line pt-4">
                  <span className="text-sm text-muted">
                    Your max ${me.myMaxBid} · budget ${me.myBudget}
                  </span>
                  <div className="ml-auto flex gap-2">
                    {[1, 5, 10].map((d) => (
                      <button
                        key={d}
                        disabled={pending || state.currentBid + d > me.myMaxBid}
                        onClick={() => quickBid(d)}
                        className={buttonClasses("secondary", "sm")}
                      >
                        +${d}
                      </button>
                    ))}
                    <button
                      disabled={pending || me.myMaxBid <= state.currentBid}
                      onClick={() =>
                        act("/api/draft/bid", { amount: me.myMaxBid })
                      }
                      className={buttonClasses("primary", "sm")}
                    >
                      Max ${me.myMaxBid}
                    </button>
                  </div>
                </div>
              ) : me.myTeamId && state.currentBidTeamId === me.myTeamId ? (
                <div className="w-full border-t border-line pt-3 text-sm text-success">
                  You hold the high bid.
                </div>
              ) : rosterFull ? (
                <div className="w-full border-t border-line pt-3 text-sm text-muted">
                  Your roster is full — you&apos;re done bidding.
                </div>
              ) : pricedOut ? (
                <div className="w-full border-t border-line pt-3 text-sm text-muted">
                  Priced out — your max bid is ${me.myMaxBid} (reserving $
                  {state.minBid} per remaining slot).
                </div>
              ) : null}
            </div>
          ) : me.canNominate ? (
            <NominateBar
              state={state}
              selected={selected}
              setSelected={setSelected}
              nomAmount={nomAmount}
              setNomAmount={setNomAmount}
              pending={pending}
              onNominate={(playerId, amount) =>
                act("/api/draft/nominate", { playerId, amount })
              }
            />
          ) : (
            <div className="flex flex-col items-center gap-3 py-4">
              <p className="text-center text-muted">
                Waiting for {nominatorName} to nominate a player…
              </p>
              {me.isAdmin ? (
                <button
                  disabled={pending}
                  onClick={() => act("/api/draft/admin-nominate", {})}
                  className={buttonClasses("secondary", "sm")}
                >
                  Admin: auto-nominate top player
                </button>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <AuctionPrimer
        minBid={state.minBid}
        teamSize={state.teamSize}
        defaultOpen={false}
      />

      {/* Pool column FIRST in DOM: on a phone the pool is what a captain on
          the clock needs NOW — team cards would otherwise bury it 3-4 screens
          down (and screen readers/tab order reach the pool first too).
          lg:order-* restores the desktop layout: teams left, feed above pool
          on the right. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-6 lg:order-2">
          {/* scroll-mt clears the 80px sticky header + the fixed clock bar
              when the NominateBar's #player-pool anchor jumps here. */}
          <div id="player-pool" className="scroll-mt-32 lg:order-2">
            <AvailableList
              state={state}
              canNominate={me.canNominate}
              selected={selected}
              onPick={(userId) => {
                setSelected(userId);
                setNomAmount(state.minBid);
              }}
            />
          </div>
          <div className="lg:order-1">
            <BidFeed events={events} />
          </div>
        </div>
        <div className="min-w-0 lg:order-1 lg:col-span-2">
          <TeamsGrid state={state} />
        </div>
      </div>
    </div>
  );
}

// The auction's shopping list. Draft night runs on a clock, so captains get
// search, position filters, and sorting instead of one long MMR-sorted list.
function AvailableList({
  state,
  canNominate,
  selected,
  onPick,
}: {
  state: DraftState;
  canNominate: boolean;
  selected: string | null;
  onPick: (userId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<string | null>(null);
  const [sort, setSort] = useState<PoolSort>("mmr");
  const shown = filterAndSortPlayers(state.available, { query, role, sort });

  return (
    <div className="rounded-[var(--radius)] border border-line bg-surface/80">
      <div className="border-b border-line px-5 py-3 text-sm font-semibold">
        Available · {state.available.length}
      </div>
      {state.available.length > 0 ? (
        <div className="space-y-2 border-b border-line/60 p-3">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search players…"
            aria-label="Search available players"
            className="h-8 w-full rounded-md border border-line bg-surface-2/50 px-2.5 text-sm outline-none focus:border-accent/60"
          />
          <div className="flex flex-wrap items-center gap-1">
            <div
              role="group"
              aria-label="Filter by role"
              className="flex items-center gap-1"
            >
              <button
                onClick={() => setRole(null)}
                aria-pressed={role === null}
                className={cn(
                  "rounded-md px-2 py-0.5 text-xs",
                  role === null
                    ? "bg-accent/20 text-fg ring-1 ring-accent/40"
                    : "text-muted hover:bg-surface-2",
                )}
              >
                All
              </button>
              {DOTA_ROLES.map((r) => (
                <button
                  key={r.key}
                  title={r.label}
                  aria-label={r.label}
                  aria-pressed={role === r.key}
                  onClick={() => setRole(role === r.key ? null : r.key)}
                  className={cn(
                    "rounded-md px-2 py-0.5 text-xs tabular-nums",
                    role === r.key
                      ? "bg-accent/20 text-fg ring-1 ring-accent/40"
                      : "text-muted hover:bg-surface-2",
                  )}
                >
                  {r.key}
                </button>
              ))}
            </div>
            <span className="mx-1 h-4 w-px bg-line" aria-hidden />
            {(["mmr", "rank", "name"] as const).map((s) => (
              <button
                key={s}
                aria-label={`Sort by ${s}`}
                aria-pressed={sort === s}
                onClick={() => setSort(s)}
                className={cn(
                  "rounded-md px-2 py-0.5 text-xs capitalize",
                  sort === s
                    ? "bg-accent/20 text-fg ring-1 ring-accent/40"
                    : "text-muted hover:bg-surface-2",
                )}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="max-h-[30rem] space-y-1 overflow-y-auto p-3">
        {shown.map((p) => {
          return (
            // The row body is the nominate button; the profile link is a
            // sibling anchor (never nested inside the button).
            <div
              key={p.userId}
              className={cn(
                "flex items-center rounded-md",
                selected === p.userId ? "bg-accent/15 ring-1 ring-accent/40" : "",
              )}
            >
              <button
                disabled={!canNominate}
                onClick={() => onPick(p.userId)}
                aria-pressed={selected === p.userId}
                className={cn(
                  "flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                  canNominate
                    ? "hover:bg-surface-2"
                    : "cursor-default opacity-90",
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Avatar name={p.name} src={p.avatar} size={20} />
                  <span className="truncate">{p.name}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-muted">
                  <RoleBadges roles={p.roles} />
                  <RankBadge rankTier={p.rankTier} />
                  {p.mmr > 0 ? <span>{p.mmr}</span> : null}
                </span>
              </button>
              <Link
                href={`/players/${p.userId}`}
                target="_blank"
                rel="noreferrer"
                aria-label={`${p.name} profile`}
                title="Open profile in a new tab"
                className="shrink-0 px-2 py-1.5 text-muted hover:text-info"
              >
                ↗
              </Link>
            </div>
          );
        })}
        {state.available.length === 0 ? (
          <p className="p-2 text-sm text-muted">All players drafted.</p>
        ) : shown.length === 0 ? (
          <p className="p-2 text-sm text-muted">
            No one matches — clear the search or role filter.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function BidFeed({ events }: { events: FeedEvent[] }) {
  return (
    <div className="rounded-[var(--radius)] border border-line bg-surface/80">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3 text-sm font-semibold">
        <span className="animate-live-pulse inline-block h-1.5 w-1.5 rounded-full bg-danger" />
        Live feed
      </div>
      <div className="max-h-64 space-y-0.5 overflow-y-auto p-3">
        {events.length === 0 ? (
          <p className="p-2 text-sm text-muted">
            Nominations, bids, and picks appear here…
          </p>
        ) : (
          events.map((e) => (
            <div
              key={e.id}
              className={cn(
                "flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm",
                e.kind === "sold" && "bg-success/5",
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span aria-hidden>
                  {e.kind === "sold" ? "✅" : e.kind === "bid" ? "💰" : "🎯"}
                </span>
                <span className="truncate">{e.text}</span>
              </span>
              <span
                className={cn(
                  "shrink-0 font-mono text-xs tabular-nums",
                  e.kind === "sold" ? "font-bold text-success" : "text-accent",
                )}
              >
                ${e.amount}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function NominateBar({
  state,
  selected,
  nomAmount,
  setNomAmount,
  pending,
  onNominate,
}: {
  state: DraftState;
  selected: string | null;
  setSelected: (id: string | null) => void;
  nomAmount: number;
  setNomAmount: (n: number) => void;
  pending: boolean;
  onNominate: (playerId: string, amount: number) => void;
}) {
  const player = state.available.find((p) => p.userId === selected);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Badge tone="accent">You&apos;re on the clock</Badge>
      {player ? (
        <span className="flex items-center gap-2 text-sm">
          <Avatar name={player.name} src={player.avatar} size={24} />
          {player.name}
        </span>
      ) : (
        <a
          href="#player-pool"
          className="text-sm text-muted underline decoration-line underline-offset-4 hover:text-fg"
        >
          Pick a player from the pool
          <span className="lg:hidden"> ↓</span>
          <span className="hidden lg:inline"> →</span>
        </a>
      )}
      <div className="ml-auto flex items-center gap-2">
        <label className="text-sm text-muted">Opening $</label>
        <input
          type="number"
          min={state.minBid}
          max={state.me.myMaxBid}
          value={nomAmount}
          onChange={(e) => setNomAmount(Number(e.target.value))}
          className="h-9 w-20 rounded-md border border-line bg-surface-2/50 px-2 text-center text-sm"
        />
        <button
          disabled={
            pending ||
            !selected ||
            nomAmount < state.minBid ||
            nomAmount > state.me.myMaxBid
          }
          onClick={() => selected && onNominate(selected, nomAmount)}
          className={buttonClasses("accent", "sm")}
        >
          Nominate
        </button>
      </div>
    </div>
  );
}

// How the auction works — the learn audience has mostly never drafted this
// way, and every one of these rules was previously discoverable only by being
// burned by it. Static native <details>: accessible by default, no clock leaf.
function AuctionPrimer({
  minBid,
  teamSize,
  defaultOpen,
}: {
  minBid: number;
  teamSize: number;
  defaultOpen: boolean;
}) {
  return (
    <details
      open={defaultOpen || undefined}
      className="rounded-[var(--radius)] border border-line bg-surface/60"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
        <span aria-hidden>📖</span> How the auction works
        <span className="ml-auto text-xs font-normal text-muted">
          rules &amp; timers
        </span>
      </summary>
      <ul className="space-y-2 border-t border-line/60 px-5 py-4 text-sm text-muted">
        <li>
          <strong className="text-fg">Captains take turns nominating</strong>{" "}
          a player from the pool — the order rotates until every roster is
          full. Non-captains: sit back, you're the merchandise.
        </li>
        <li>
          <strong className="text-fg">
            Idle for {DEFAULTS.NOMINATION_TIMER_SECONDS}s on your nomination
          </strong>{" "}
          and the draft auto-nominates the top available player at ${minBid}{" "}
          for you — take your time, but not all of it.
        </li>
        <li>
          <strong className="text-fg">
            Every bid resets the {DEFAULTS.BID_TIMER_SECONDS}s clock.
          </strong>{" "}
          When it hits zero, the high bidder wins the player.
        </li>
        <li>
          <strong className="text-fg">Your max bid is capped</strong> — the
          room reserves ${minBid} for each seat you'd still have to fill
          afterwards, so you can always finish your roster.
        </li>
        <li>
          <strong className="text-fg">Captains cost $0</strong> (they fill one
          of the {teamSize} roster seats), and leftover budget is worth
          nothing once the draft ends — spend it.
        </li>
      </ul>
    </details>
  );
}

function TeamsGrid({ state }: { state: DraftState }) {
  // A player is up for auction → the "max bid" lines can flag who's priced out.
  const nominationLive = !!state.nominatedPlayer;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {state.teams.map((t) => {
        const onClock =
          state.status === "IN_PROGRESS" && t.id === state.nominatorTeamId;
        const highBid = t.id === state.currentBidTeamId;
        // Derived from the roster, not me.myTeamId (that's captain-only) —
        // drafted players get a persistent home marker too.
        const isMyTeam =
          !!state.me.userId &&
          t.members.some((m) => m.userId === state.me.userId);
        // The most this team can still bid on the current player while
        // reserving the minimum for its remaining empty slots.
        const cap = maxBid(
          { id: t.id, budget: t.budget, rosterCount: t.members.length },
          state.teamSize,
          state.minBid,
        );
        return (
          <div
            key={t.id}
            className={cn(
              "rounded-[var(--radius)] border bg-surface/80 transition-all",
              onClock
                ? "border-accent/70 ring-2 ring-accent/30"
                : highBid
                  ? "border-success/50 ring-1 ring-success/25"
                  : "border-line",
            )}
          >
            <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2 font-display text-base font-semibold">
                  <TeamCrest
                    name={t.name}
                    seed={t.id}
                    size={22}
                    className="shrink-0 rounded-md"
                  />
                  <Link
                    href={`/teams/${t.id}`}
                    className="truncate hover:text-info hover:underline"
                  >
                    {t.name}
                  </Link>
                  {onClock ? (
                    <span className="shrink-0">
                      <Badge tone="accent">on clock</Badge>
                    </span>
                  ) : null}
                  {isMyTeam ? (
                    <span className="shrink-0">
                      <Badge tone="info">Your team</Badge>
                    </span>
                  ) : null}
                  {highBid ? (
                    <span className="shrink-0">
                      <Badge tone="success">high bid</Badge>
                    </span>
                  ) : null}
                </div>
                <div className="text-xs text-muted">
                  {t.members.length}/{state.teamSize} · needs {t.need}
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Badge tone="accent">${t.budget}</Badge>
                {t.need === 0 ? (
                  <span className="text-[10px] text-muted/70">full</span>
                ) : (
                  <span
                    className={cn(
                      "text-[10px] tabular-nums",
                      nominationLive && cap <= state.currentBid
                        ? "text-danger/80"
                        : "text-muted/70",
                    )}
                  >
                    max ${cap}
                  </span>
                )}
              </div>
            </div>
            <div className="space-y-1 p-3">
              {Array.from({ length: state.teamSize }).map((_, i) => {
                const m = t.members[i];
                return m ? (
                  <div
                    key={m.userId}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Avatar name={m.name} src={m.avatar} size={20} />
                      <PlayerLink userId={m.userId} className="min-w-0 truncate">
                        {m.name}
                      </PlayerLink>
                      {m.isCaptain ? (
                        <span className="shrink-0">
                          <Badge tone="accent">C</Badge>
                        </span>
                      ) : null}
                      <RankBadge rankTier={m.rankTier} />
                    </span>
                    <span className="shrink-0 text-muted">
                      {m.isCaptain ? "—" : `$${m.price}`}
                    </span>
                  </div>
                ) : (
                  <div key={i} className="py-1 text-sm text-muted/50">
                    Empty slot
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
