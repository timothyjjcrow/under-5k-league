import {
  Avatar,
  Badge,
  HeroIcon,
  KDA,
  PlayerLink,
  textLink,
} from "@/components/ui";
import { type InhouseBoxPlayer as BoxPlayer } from "@/lib/inhouse-box";
import { heroById } from "@/lib/heroes";
import { gameMvp } from "@/lib/achievements";
import { cn, formatNetWorth } from "@/lib/utils";

export function InhouseBoxScore({
  lobby,
  players,
  avatarMap,
  eloDeltas,
  roster = [],
}: {
  lobby: {
    id: string;
    winnerTeam: number | null;
    radiantTeam: number;
    dotaMatchId: string | null;
    durationSecs: number | null;
    radiantScore: number | null;
    direScore: number | null;
    createdAt: Date;
  };
  players: BoxPlayer[];
  avatarMap: Map<string, string | null>;
  eloDeltas?: string;
  roster?: {
    userId: string;
    team: number | null;
    user: { name: string; avatar: string | null };
  }[];
}) {
  const deltas = storedEloDeltas(eloDeltas);
  const radiantWin =
    lobby.winnerTeam != null && lobby.winnerTeam === lobby.radiantTeam;
  const radiant = players.filter((p) => p.isRadiant);
  const dire = players.filter((p) => !p.isRadiant);
  // Best line of the game — same tested MVP math the league box scores use.
  const mvpId = gameMvp(players, radiantWin);
  const dur = lobby.durationSecs ?? 0;
  const durStr = `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")}`;
  const maxNet = Math.max(1, ...players.map((p) => p.netWorth ?? 0));
  const radiantNet = radiant.reduce((s, p) => s + (p.netWorth ?? 0), 0);
  const direNet = dire.reduce((s, p) => s + (p.netWorth ?? 0), 0);

  return (
    // No <Card> here: the scoreline, winner, MVP, duration and time all live in
    // the <details> summary above, and the <details> carries the border. A card
    // inside it would double the frame and repeat the header.
    <div className="grid grid-cols-1 gap-x-4 gap-y-4 p-4 sm:p-5 md:grid-cols-2">
      {players.length === 0 ? (
        <p className="text-sm text-muted md:col-span-2">
          The full box score is unavailable for this game. The recorded roster
          is shown below.
        </p>
      ) : null}
      <InhouseNetWorthBar radiantNet={radiantNet} direNet={direNet} />
      {players.length > 0 ? (
        <SideBox
          label="Radiant"
          win={radiantWin}
          players={radiant}
          avatarMap={avatarMap}
          maxNet={maxNet}
          mvpId={mvpId}
          deltas={deltas}
        />
      ) : (
        <RosterSummary
          roster={roster.filter((p) => p.team === lobby.radiantTeam)}
          label="Radiant"
          deltas={deltas}
        />
      )}
      {players.length > 0 ? (
        <SideBox
          label="Dire"
          win={!radiantWin}
          players={dire}
          avatarMap={avatarMap}
          maxNet={maxNet}
          mvpId={mvpId}
          deltas={deltas}
        />
      ) : (
        <RosterSummary
          roster={roster.filter(
            (p) => p.team !== null && p.team !== lobby.radiantTeam,
          )}
          label="Dire"
          deltas={deltas}
        />
      )}
      {Object.keys(deltas).length > 0 ? (
        <p className="text-[11px] text-muted md:col-span-2">
          Elo changes shown as recorded when this result landed.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-3 text-xs text-muted md:col-span-2">
        <span className="tabular-nums">Duration {dur > 0 ? durStr : "—"}</span>
        {lobby.dotaMatchId ? (
          <a
            href={`https://www.opendota.com/matches/${lobby.dotaMatchId}`}
            target="_blank"
            rel="noreferrer"
            className={textLink()}
          >
            Full match on OpenDota ↗
          </a>
        ) : null}
      </div>
    </div>
  );
}

// Radiant (green) vs Dire (red) net-worth split — the "who's ahead" summary.
function InhouseNetWorthBar({
  radiantNet,
  direNet,
}: {
  radiantNet: number;
  direNet: number;
}) {
  const total = radiantNet + direNet;
  if (total <= 0) return null;
  const radPct = Math.round((radiantNet / total) * 100);
  const lead = radiantNet - direNet;
  return (
    <div className="md:col-span-2">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5 font-medium text-success">
          <span className="h-2 w-2 rounded-full bg-success" />
          Radiant
          <span className="font-mono text-muted">
            {formatNetWorth(radiantNet)}
          </span>
        </span>
        <span className="order-last w-full text-center text-muted sm:order-none sm:w-auto">
          {lead === 0
            ? "Even net worth"
            : `Net worth · ${lead > 0 ? "Radiant" : "Dire"} +${formatNetWorth(Math.abs(lead))}`}
        </span>
        <span className="flex items-center gap-1.5 font-medium text-danger">
          <span className="font-mono text-muted">
            {formatNetWorth(direNet)}
          </span>
          Dire
          <span className="h-2 w-2 rounded-full bg-danger" />
        </span>
      </div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className="bg-success/70 transition-all"
          style={{ width: `${radPct}%` }}
        />
        <div className="flex-1 bg-danger/70" />
      </div>
    </div>
  );
}

function SideBox({
  label,
  win,
  players,
  avatarMap,
  maxNet,
  mvpId,
  deltas,
}: {
  label: string;
  win: boolean;
  players: BoxPlayer[];
  avatarMap: Map<string, string | null>;
  maxNet: number;
  mvpId: string | null;
  deltas: Record<string, number>;
}) {
  const isRadiant = label === "Radiant";
  const hasNet = players.some((p) => p.netWorth != null);
  const hasGpm = players.some((p) => p.gpm != null);
  const hasLh = players.some((p) => p.lastHits != null);
  // Sort by farm so the gold bars descend, like Dota's post-game screen.
  const ordered = [...players].sort(
    (a, b) => (b.netWorth ?? 0) - (a.netWorth ?? 0) || b.kills - a.kills,
  );
  return (
    <div
      className={cn(
        "@container/box rounded-lg border p-3",
        win
          ? isRadiant
            ? "border-success/40 bg-success/5"
            : "border-danger/40 bg-danger/5"
          : "border-line",
      )}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <span
            className={cn(
              "h-2.5 w-2.5 rounded-full",
              isRadiant ? "bg-success" : "bg-danger",
            )}
          />
          {label}
        </span>
        <Badge tone={win ? "success" : "neutral"}>{win ? "Win" : "Loss"}</Badge>
      </div>
      <ul className="space-y-0.5">
        {ordered.map((p, i) => {
          const hero = heroById(p.heroId);
          const nwPct =
            p.netWorth != null ? Math.round((p.netWorth / maxNet) * 100) : 0;
          return (
            <li
              key={i}
              className="rounded-md px-1.5 py-1.5 transition-colors hover:bg-surface-2/50"
            >
              <div className="flex flex-col gap-2 @min-[26rem]/box:flex-row @min-[26rem]/box:items-center @min-[26rem]/box:gap-2.5">
                <div className="flex min-w-0 items-center gap-2.5 @min-[26rem]/box:flex-1">
                  {hero ? (
                    <HeroIcon hero={hero} size={30} />
                  ) : (
                    <span className="h-[30px] w-[30px] shrink-0 rounded-md border border-line/70 bg-surface-2" />
                  )}
                  <div className="min-w-0 flex-1">
                    {p.userId ? (
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Avatar
                          name={p.name ?? "?"}
                          src={avatarMap.get(p.userId) ?? null}
                          size={18}
                        />
                        <PlayerLink
                          userId={p.userId}
                          className="truncate text-sm"
                        >
                          {p.name ?? "Unknown"}
                        </PlayerLink>
                        {p.userId === mvpId ? (
                          <span
                            role="img"
                            aria-label="Match MVP"
                            title="Match MVP — best line of the game"
                            className="shrink-0 text-xs"
                          >
                            🏅
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="truncate text-sm text-muted">
                        {p.name ?? "Unknown"}
                      </span>
                    )}
                    <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
                      {hero ? (
                        <span className="truncate">{hero.name}</span>
                      ) : null}
                      {p.userId && deltas[p.userId] != null ? (
                        <EloChange value={deltas[p.userId]} />
                      ) : null}
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-line/40 pt-2 @min-[26rem]/box:border-0 @min-[26rem]/box:pt-0">
                  <div className="flex min-w-0 items-center gap-3 @min-[26rem]/box:block @min-[26rem]/box:shrink-0 @min-[26rem]/box:text-right">
                    <KDA
                      kills={p.kills}
                      deaths={p.deaths}
                      assists={p.assists}
                      className="block text-xs"
                    />
                    {hasGpm || hasLh ? (
                      <div className="text-[11px] tabular-nums text-muted">
                        {[
                          hasGpm ? `${p.gpm ?? "—"} gpm` : null,
                          hasLh ? `${p.lastHits ?? "—"} lh` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    ) : null}
                  </div>
                  {hasNet ? (
                    <div className="w-14 shrink-0 text-right" title="Net worth">
                      <div className="font-mono text-xs tabular-nums text-accent">
                        {formatNetWorth(p.netWorth)}
                      </div>
                      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-2">
                        <div
                          className="h-full rounded-full bg-accent/80"
                          style={{ width: `${nwPct}%` }}
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function storedEloDeltas(json?: string): Record<string, number> {
  try {
    const value: unknown = JSON.parse(json ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

function EloChange({ value }: { value: number }) {
  return (
    <span
      className={cn(
        "whitespace-nowrap text-[11px] font-medium tabular-nums",
        value > 0 ? "text-success" : value < 0 ? "text-danger" : "text-muted",
      )}
    >
      {value > 0 ? "+" : ""}
      {value} Elo
    </span>
  );
}

function RosterSummary({
  roster,
  label,
  deltas,
}: {
  roster: {
    userId: string;
    team: number | null;
    user: { name: string; avatar: string | null };
  }[];
  label: string;
  deltas: Record<string, number>;
}) {
  return (
    <div className="rounded-xl border border-line p-3">
      <h3
        className={cn(
          "mb-3 text-sm font-semibold",
          label === "Radiant" ? "text-success" : "text-danger",
        )}
      >
        {label}
      </h3>
      {roster.length ? (
        <ul className="space-y-3">
          {roster.map((player) => (
            <li key={player.userId} className="flex min-w-0 items-center gap-2">
              <Avatar
                name={player.user.name}
                src={player.user.avatar}
                size={26}
              />
              <PlayerLink
                userId={player.userId}
                className="min-w-0 flex-1 truncate text-sm"
              >
                {player.user.name}
              </PlayerLink>
              {deltas[player.userId] != null ? (
                <EloChange value={deltas[player.userId]} />
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">Roster unavailable</p>
      )}
    </div>
  );
}
