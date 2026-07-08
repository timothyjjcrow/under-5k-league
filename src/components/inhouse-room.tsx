"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar, Badge, PlayerLink, RankBadge, buttonClasses } from "@/components/ui";
import { pushToast } from "@/components/toaster";
import { cn } from "@/lib/utils";
import type { InhouseState } from "@/lib/inhouse-service";

type LobbyTeam = NonNullable<InhouseState["lobby"]>["teams"][number];
type Player = LobbyTeam["players"][number];

// Radiant = green, Dire = red — matching the in-client colors so it reads fast.
function sideMeta(isRadiant: boolean) {
  return isRadiant
    ? {
        name: "Radiant",
        badge: "success" as const,
        ring: "border-success/50",
        chip: "bg-success/10 text-success border-success/30",
        dot: "bg-success",
      }
    : {
        name: "Dire",
        badge: "danger" as const,
        ring: "border-danger/50",
        chip: "bg-danger/10 text-danger border-danger/30",
        dot: "bg-danger",
      };
}

export function InhouseRoom({
  pollMs = 1500,
  defaultMmr = 0,
}: {
  pollMs?: number;
  defaultMmr?: number;
}) {
  const router = useRouter();
  const [state, setState] = useState<InhouseState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [, forceTick] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [mmr, setMmr] = useState<number>(defaultMmr);
  const offsetRef = useRef(0); // serverNow - clientNow, to sync the clock
  const prevLobbyId = useRef<string | null>(null);

  const apply = useCallback((s: InhouseState) => {
    offsetRef.current = s.now - Date.now();
    setState(s);
  }, []);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/inhouse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "state" }),
      });
      if (res.ok) apply(await res.json());
    } catch {
      /* transient blip; next poll retries */
    }
  }, [apply]);

  useEffect(() => {
    poll();
    const id = setInterval(poll, pollMs);
    return () => clearInterval(id);
  }, [poll, pollMs]);

  // Local 250ms ticker keeps the countdown smooth between server polls.
  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, []);

  // When a lobby ends (or a new one forms), refresh the server-rendered
  // leaderboard + recent games sitting below this component.
  useEffect(() => {
    const cur = state?.lobby?.id ?? null;
    if (prevLobbyId.current && prevLobbyId.current !== cur) router.refresh();
    prevLobbyId.current = cur;
  }, [state?.lobby?.id, router]);

  const act = useCallback(
    async (body: Record<string, unknown>) => {
      setPending(true);
      setError(null);
      try {
        const res = await fetch("/api/inhouse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) setError(data.error || "Action failed");
        else {
          apply(data);
          setSelected(null);
        }
      } catch {
        setError("Network error");
      } finally {
        setPending(false);
      }
    },
    [apply],
  );

  if (!state) {
    return <div className="py-12 text-center text-muted">Loading inhouse…</div>;
  }

  const { lobby, me } = state;
  const offset = offsetRef.current; // serverNow - clientNow, for the pick clock

  return (
    <div className="space-y-6">
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {!lobby ? (
        <QueueView state={state} pending={pending} mmr={mmr} setMmr={setMmr} act={act} />
      ) : lobby.status === "CAPTAIN_VOTE" ? (
        <VoteView lobby={lobby} me={me} offset={offset} pending={pending} act={act} />
      ) : lobby.status === "DRAFTING" ? (
        <DraftView
          state={state}
          lobby={lobby}
          offset={offset}
          selected={selected}
          setSelected={setSelected}
          pending={pending}
          act={act}
        />
      ) : lobby.status === "READY" ? (
        <ReadyView lobby={lobby} me={me} pending={pending} act={act} />
      ) : (
        <InProgressView lobby={lobby} me={me} pending={pending} act={act} />
      )}

      {me.canCancel ? (
        <div className="text-right">
          <button
            disabled={pending}
            onClick={() => {
              if (window.confirm("Scrap the current inhouse lobby?")) {
                act({ action: "cancel" });
                pushToast("success", "Lobby cancelled");
              }
            }}
            className="text-xs text-danger hover:underline"
          >
            Admin: cancel this lobby
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ---------- Queue ----------

function QueueView({
  state,
  pending,
  mmr,
  setMmr,
  act,
}: {
  state: InhouseState;
  pending: boolean;
  mmr: number;
  setMmr: (n: number) => void;
  act: (body: Record<string, unknown>) => void;
}) {
  const { queue, lobbySize, needed, me } = state;
  const pct = Math.min(100, Math.round((queue.length / lobbySize) * 100));

  return (
    <div className="space-y-6">
      <div className="overflow-hidden rounded-[var(--radius)] border border-line bg-gradient-to-b from-surface-2/60 to-surface/40">
        <div className="px-6 py-6 text-center">
          <div className="text-sm uppercase tracking-wide text-muted">
            Inhouse queue
          </div>
          <div className="mt-1 text-4xl font-bold tabular-nums">
            {queue.length}
            <span className="text-muted"> / {lobbySize}</span>
          </div>
          <div className="mt-1 text-sm text-muted">
            {needed > 0
              ? `${needed} more ${needed === 1 ? "player" : "players"} to fire up a draft`
              : "Lobby full — forming the draft…"}
          </div>

          <div className="mx-auto mt-4 h-3 w-full max-w-md overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-brand transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            {!me.isLoggedIn ? (
              <a href="/login" className={buttonClasses("primary", "lg")}>
                Sign in to queue
              </a>
            ) : me.inQueue ? (
              <button
                disabled={pending}
                onClick={() => act({ action: "leave" })}
                className={buttonClasses("secondary", "lg")}
              >
                Leave queue
              </button>
            ) : (
              <div className="flex flex-wrap items-center justify-center gap-2">
                <label className="text-sm text-muted">MMR</label>
                <input
                  type="number"
                  min={0}
                  max={12000}
                  value={mmr || ""}
                  placeholder="0"
                  onChange={(e) => setMmr(Number(e.target.value))}
                  title="Used to rank players if the lobby votes to pick captains by MMR"
                  className="h-11 w-24 rounded-lg border border-line bg-surface-2/50 px-3 text-center text-sm outline-none focus:border-accent/60"
                />
                <button
                  disabled={pending}
                  onClick={() => act({ action: "join", mmr })}
                  className={buttonClasses("accent", "lg")}
                >
                  Join queue →
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-line bg-surface/40 px-4 py-4">
          {queue.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted">
              Queue&apos;s empty — be the first in. Once {lobbySize} players are
              in, the lobby votes on how captains are chosen, then they draft the
              teams.
            </p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {queue.map((q, i) => {
                const isMe = q.userId === me.userId;
                return (
                  <li
                    key={q.userId}
                    className={cn(
                      "flex items-center gap-3 rounded-lg border px-3 py-2",
                      isMe
                        ? "border-accent/50 bg-accent/10"
                        : "border-line bg-surface-2/40",
                    )}
                  >
                    <span className="w-5 shrink-0 text-center text-xs text-muted tabular-nums">
                      {i + 1}
                    </span>
                    <Avatar name={q.name} src={q.avatar} size={30} />
                    <PlayerLink userId={q.userId} className="truncate text-sm font-medium">
                      {q.name}
                    </PlayerLink>
                    <span className="ml-auto flex items-center gap-2 text-xs text-muted">
                      <RankBadge rankTier={q.rankTier} />
                      {q.mmr > 0 ? <span>{q.mmr}</span> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <p className="text-center text-xs text-muted">
        How it works: {lobbySize} players queue → vote how captains are chosen
        (elect them, highest MMR, or best record) → captains draft{" "}
        <span className="text-success">Radiant</span> &{" "}
        <span className="text-danger">Dire</span> back and forth → someone with
        the league ticket hosts the game.
      </p>
    </div>
  );
}

// ---------- Captain vote ----------

type VoteLobby = NonNullable<InhouseState["lobby"]>;
type Candidate = NonNullable<VoteLobby["vote"]>["candidates"][number];

function VoteView({
  lobby,
  me,
  offset,
  pending,
  act,
}: {
  lobby: VoteLobby;
  me: InhouseState["me"];
  offset: number;
  pending: boolean;
  act: (body: Record<string, unknown>) => void;
}) {
  const vote = lobby.vote;
  if (!vote) return null;

  const remainingMs = lobby.voteEndsAt ? lobby.voteEndsAt - (Date.now() + offset) : 0;
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const myMethod = me.myVote?.method ?? null;
  const myNominee = me.myVote?.nomineeId ?? null;

  const byMmr = [...vote.candidates].sort((a, b) => b.mmr - a.mmr);
  const byRecord = [...vote.candidates].sort(
    (a, b) =>
      b.wins - a.wins || b.winRate - a.winRate || b.games - a.games || b.mmr - a.mmr,
  );
  const byVotes = [...vote.candidates].sort(
    (a, b) => b.nominations - a.nominations || b.mmr - a.mmr,
  );
  const hasRecords = vote.candidates.some((c) => c.games > 0);
  const hasNominations = vote.candidates.some((c) => c.nominations > 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-accent/40 bg-accent/10 px-5 py-3">
        <div>
          <div className="text-sm font-semibold">
            🗳️ How should captains be picked?
          </div>
          <div className="text-xs text-muted">
            {vote.votedCount}/{vote.voterCount} voted · lobby decides by majority
          </div>
        </div>
        <div
          className={cn(
            "font-mono text-xl font-bold tabular-nums",
            seconds <= 5 ? "text-danger" : "text-accent",
          )}
        >
          {seconds}s
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <MethodCard
          label="Elect captains"
          hint="Vote for the players you want"
          tally={vote.methodTallies.VOTE}
          total={vote.voterCount}
          selected={myMethod === "VOTE"}
          disabled
          preview={hasNominations ? byVotes.slice(0, 2) : []}
          previewEmpty="Tap players below to nominate"
        />
        <MethodCard
          label="Highest MMR"
          hint="Top 2 MMR captain"
          tally={vote.methodTallies.MMR}
          total={vote.voterCount}
          selected={myMethod === "MMR"}
          disabled={!me.canVote || pending}
          onClick={() => act({ action: "vote", method: "MMR" })}
          preview={byMmr.slice(0, 2)}
        />
        <MethodCard
          label="Best record"
          hint="Top 2 inhouse records"
          tally={vote.methodTallies.RECORD}
          total={vote.voterCount}
          selected={myMethod === "RECORD"}
          disabled={!me.canVote || pending}
          onClick={() => act({ action: "vote", method: "RECORD" })}
          preview={hasRecords ? byRecord.slice(0, 2) : []}
          previewEmpty="No records yet — falls back to MMR"
        />
      </div>

      <div className="rounded-[var(--radius)] border border-line bg-surface/80">
        <div className="flex items-center justify-between border-b border-line px-4 py-3 text-sm">
          <span className="font-semibold">Nominate a captain</span>
          <span className="text-xs text-muted">
            {me.canVote ? "tap a player to vote for them" : "spectating"}
          </span>
        </div>
        <div className="grid gap-1.5 p-3 sm:grid-cols-2">
          {vote.candidates.map((c) => {
            const picked = myNominee === c.userId && myMethod === "VOTE";
            return (
              <button
                key={c.userId}
                disabled={!me.canVote || pending}
                onClick={() => act({ action: "vote", method: "VOTE", nomineeId: c.userId })}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-sm transition-colors",
                  me.canVote ? "hover:border-accent/50" : "cursor-default",
                  picked ? "border-accent bg-accent/15" : "border-line bg-surface-2/40",
                )}
              >
                <Avatar name={c.name} src={c.avatar} size={26} />
                <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                {c.nominations > 0 ? (
                  <Badge tone="accent">
                    {c.nominations} {c.nominations === 1 ? "vote" : "votes"}
                  </Badge>
                ) : null}
                <span className="text-xs text-muted">
                  {c.games > 0 ? `${c.wins}-${c.losses}` : "new"}
                </span>
                <RankBadge rankTier={c.rankTier} />
                {c.mmr > 0 ? (
                  <span className="text-xs text-muted tabular-nums">{c.mmr}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {!me.isLoggedIn ? (
        <p className="text-center text-xs text-muted">
          Sign in to join future inhouses — this one&apos;s already drafting soon.
        </p>
      ) : null}
    </div>
  );
}

function MethodCard({
  label,
  hint,
  tally,
  total,
  selected,
  disabled,
  onClick,
  preview,
  previewEmpty,
}: {
  label: string;
  hint: string;
  tally: number;
  total: number;
  selected: boolean;
  disabled?: boolean;
  onClick?: () => void;
  preview: Candidate[];
  previewEmpty?: string;
}) {
  const pct = total > 0 ? Math.round((tally / total) * 100) : 0;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex flex-col gap-2 rounded-[var(--radius)] border bg-surface/80 p-4 text-left transition-colors",
        selected ? "border-accent bg-accent/10" : "border-line",
        !disabled && onClick ? "hover:border-accent/50" : "",
        disabled && !selected ? "opacity-90" : "",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="font-semibold">{label}</span>
        {selected ? <Badge tone="accent">your vote</Badge> : null}
      </div>
      <span className="text-xs text-muted">{hint}</span>

      <div className="mt-1 flex items-center gap-2">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full rounded-full bg-accent transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="text-xs tabular-nums text-muted">{tally}</span>
      </div>

      <div className="min-h-[1.75rem] pt-1">
        {preview.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {preview.map((c) => (
              <span
                key={c.userId}
                className="flex items-center gap-1 rounded-full border border-line bg-surface-2/50 py-0.5 pl-0.5 pr-2 text-xs"
              >
                <Avatar name={c.name} src={c.avatar} size={18} />
                <span className="max-w-[6rem] truncate">{c.name}</span>
              </span>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted/70">{previewEmpty}</span>
        )}
      </div>
    </button>
  );
}

// ---------- Draft ----------

function DraftView({
  state,
  lobby,
  offset,
  selected,
  setSelected,
  pending,
  act,
}: {
  state: InhouseState;
  lobby: NonNullable<InhouseState["lobby"]>;
  offset: number;
  selected: string | null;
  setSelected: (id: string | null) => void;
  pending: boolean;
  act: (body: Record<string, unknown>) => void;
}) {
  const { me, teamSize } = state;
  const remainingMs = lobby.pickEndsAt ? lobby.pickEndsAt - (Date.now() + offset) : 0;
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const onClockTeam = lobby.teams.find((t) => t.team === lobby.pickTeam);
  const onClockSide = onClockTeam ? sideMeta(onClockTeam.isRadiant) : null;

  return (
    <div className="space-y-5">
      {/* On the clock banner */}
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border bg-surface/80 px-5 py-3",
          onClockSide?.ring ?? "border-line",
        )}
      >
        <div className="text-sm">
          <span className="text-muted">On the clock: </span>
          <span className="font-semibold">
            {lobby.onClockCaptain?.name ?? "—"}
          </span>
          {onClockSide ? (
            <Badge tone={onClockSide.badge} className="ml-2">
              {onClockSide.name}
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          {me.isOnClock ? (
            <Badge tone="accent">Your pick</Badge>
          ) : (
            <span className="text-xs text-muted">Drafting…</span>
          )}
          <div
            className={cn(
              "font-mono text-xl font-bold tabular-nums",
              seconds <= 10 ? "text-danger" : "text-accent",
            )}
          >
            {seconds}s
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1.1fr_1fr]">
        <TeamColumn
          team={lobby.teams[0]}
          teamSize={teamSize}
          onClock={lobby.pickTeam === lobby.teams[0].team}
        />

        {/* Draft pool */}
        <div className="rounded-[var(--radius)] border border-line bg-surface/80">
          <div className="border-b border-line px-4 py-3 text-sm font-semibold">
            Draft pool · {lobby.pool.length}
          </div>
          <div className="space-y-1.5 p-3">
            {lobby.pool.map((p) => {
              const pickable = me.isOnClock;
              const isSel = selected === p.userId;
              return (
                <button
                  key={p.userId}
                  disabled={!pickable}
                  onClick={() => setSelected(isSel ? null : p.userId)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-sm transition-colors",
                    pickable ? "hover:border-accent/50" : "cursor-default",
                    isSel
                      ? "border-accent bg-accent/15"
                      : "border-line bg-surface-2/40",
                  )}
                >
                  <Avatar name={p.name} src={p.avatar} size={26} />
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {p.name}
                  </span>
                  <RankBadge rankTier={p.rankTier} />
                  {p.mmr > 0 ? (
                    <span className="text-xs text-muted tabular-nums">{p.mmr}</span>
                  ) : null}
                </button>
              );
            })}
            {lobby.pool.length === 0 ? (
              <p className="p-2 text-center text-sm text-muted">
                Everyone&apos;s drafted.
              </p>
            ) : null}
          </div>
          {me.isOnClock ? (
            <div className="border-t border-line p-3">
              <button
                disabled={pending || !selected}
                onClick={() => selected && act({ action: "pick", userId: selected })}
                className={buttonClasses("accent", "md", "w-full")}
              >
                {selected
                  ? `Draft ${lobby.pool.find((p) => p.userId === selected)?.name ?? ""}`
                  : "Select a player to draft"}
              </button>
            </div>
          ) : null}
        </div>

        <TeamColumn
          team={lobby.teams[1]}
          teamSize={teamSize}
          onClock={lobby.pickTeam === lobby.teams[1].team}
        />
      </div>
    </div>
  );
}

function TeamColumn({
  team,
  teamSize,
  onClock,
}: {
  team: LobbyTeam;
  teamSize: number;
  onClock: boolean;
}) {
  const meta = sideMeta(team.isRadiant);
  const roster: (Player | null)[] = [
    team.captain,
    ...team.players,
  ];
  while (roster.length < teamSize) roster.push(null);

  return (
    <div
      className={cn(
        "rounded-[var(--radius)] border bg-surface/80",
        onClock ? meta.ring : "border-line",
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between gap-2 border-b border-line px-4 py-3",
        )}
      >
        <div className="flex items-center gap-2">
          <span className={cn("h-2.5 w-2.5 rounded-full", meta.dot)} />
          <span className="font-semibold">{meta.name}</span>
        </div>
        {onClock ? <Badge tone="accent">picking</Badge> : null}
      </div>
      <div className="space-y-1.5 p-3">
        {roster.map((p, i) => (
          <div
            key={p?.userId ?? i}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-sm",
              p ? "border-line bg-surface-2/40" : "border-dashed border-line/60",
            )}
          >
            {p ? (
              <>
                <Avatar name={p.name} src={p.avatar} size={24} />
                <PlayerLink userId={p.userId} className="min-w-0 flex-1 truncate">
                  {p.name}
                </PlayerLink>
                {i === 0 ? <Badge tone={meta.badge}>C</Badge> : null}
                <RankBadge rankTier={p.rankTier} />
              </>
            ) : (
              <span className="py-0.5 pl-1 text-muted/50">Empty slot</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Ready ----------

function ReadyView({
  lobby,
  me,
  pending,
  act,
}: {
  lobby: NonNullable<InhouseState["lobby"]>;
  me: InhouseState["me"];
  pending: boolean;
  act: (body: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-5">
      <div className="rounded-[var(--radius)] border border-accent/40 bg-accent/10 px-6 py-5 text-center">
        <div className="text-2xl">🎮</div>
        <div className="mt-1 text-lg font-semibold">Teams are set!</div>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted">
          Whoever has the league ticket hosts a private lobby in Dota 2, invites
          both teams, then hits start below once everyone&apos;s in.
        </p>
        {me.canStart ? (
          <button
            disabled={pending}
            onClick={() => act({ action: "start" })}
            className={buttonClasses("accent", "lg", "mt-4")}
          >
            Start the game →
          </button>
        ) : (
          <p className="mt-3 text-sm text-muted">
            Waiting for a player to launch the lobby…
          </p>
        )}
      </div>

      <MatchupGrid lobby={lobby} />
    </div>
  );
}

// ---------- In progress ----------

function InProgressView({
  lobby,
  me,
  pending,
  act,
}: {
  lobby: NonNullable<InhouseState["lobby"]>;
  me: InhouseState["me"];
  pending: boolean;
  act: (body: Record<string, unknown>) => void;
}) {
  const [matchId, setMatchId] = useState("");

  return (
    <div className="space-y-5">
      <div className="rounded-[var(--radius)] border border-info/40 bg-info/10 px-6 py-5 text-center">
        <div className="flex items-center justify-center gap-2 text-lg font-semibold">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-info/70" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-info" />
          </span>
          Game in progress
        </div>
        {lobby.startedByName ? (
          <p className="mt-1 text-sm text-muted">Hosted by {lobby.startedByName}</p>
        ) : null}
        {me.canRecord ? (
          <div className="mt-4 space-y-3">
            <div>
              <button
                disabled={pending}
                onClick={() => act({ action: "detect" })}
                className={buttonClasses("accent", "md")}
              >
                {pending ? "Fetching from OpenDota…" : "Auto-detect result"}
              </button>
              <p className="mx-auto mt-1.5 max-w-sm text-xs text-muted">
                Finds your game on OpenDota and pulls the full box score. Also runs
                automatically every few minutes once the game&apos;s finished (needs
                players&apos; &ldquo;Expose Public Match Data&rdquo; on).
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2 border-t border-info/20 pt-3">
              <span className="text-xs text-muted">or paste the match ID:</span>
              <input
                value={matchId}
                onChange={(e) => setMatchId(e.target.value)}
                placeholder="e.g. 7891234567"
                className="h-9 w-44 rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60"
              />
              <button
                disabled={pending || !matchId.trim()}
                onClick={() => act({ action: "record", matchId: matchId.trim() })}
                className={buttonClasses("secondary", "sm")}
              >
                Record
              </button>
            </div>
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted">
            The result is pulled from OpenDota automatically once the game ends.
          </p>
        )}
      </div>

      <MatchupGrid lobby={lobby} />
    </div>
  );
}

// ---------- Shared roster grid ----------

function MatchupGrid({
  lobby,
}: {
  lobby: NonNullable<InhouseState["lobby"]>;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {lobby.teams.map((t) => {
        const meta = sideMeta(t.isRadiant);
        const roster = t.captain ? [t.captain, ...t.players] : t.players;
        const avgMmr =
          roster.length > 0
            ? Math.round(roster.reduce((s, p) => s + p.mmr, 0) / roster.length)
            : 0;
        return (
          <div
            key={t.team}
            className={cn("rounded-[var(--radius)] border bg-surface/80", meta.ring)}
          >
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div className="flex items-center gap-2 font-semibold">
                <span className={cn("h-2.5 w-2.5 rounded-full", meta.dot)} />
                {meta.name}
              </div>
              {avgMmr > 0 ? (
                <span className="text-xs text-muted">avg {avgMmr} MMR</span>
              ) : null}
            </div>
            <div className="space-y-1.5 p-3">
              {roster.map((p, i) => (
                <div key={p.userId} className="flex items-center gap-2 text-sm">
                  <Avatar name={p.name} src={p.avatar} size={24} />
                  <PlayerLink userId={p.userId} className="min-w-0 flex-1 truncate">
                    {p.name}
                  </PlayerLink>
                  {i === 0 ? <Badge tone={meta.badge}>C</Badge> : null}
                  <RankBadge rankTier={p.rankTier} />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
