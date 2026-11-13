import { CopyChip } from "@/components/copy-chip";
import { Badge } from "@/components/ui";
import { LEAGUE_GAME_MODE } from "@/lib/constants";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import {
  SCRIM_JOIN_PATH,
  SCRIM_LOBBY_PATH,
  SCRIM_TICKET_PATH,
  scrimHostNote,
  scrimLobbyName,
  scrimMatchSettings,
  scrimTicketNote,
} from "@/lib/scrim-lobby";
import { cn } from "@/lib/utils";

/**
 * How to set up a booked scrim's Dota lobby so its games record: who hosts,
 * the lobby's name and password, the league ticket, the match settings and
 * how everyone else gets in. Every value comes from data (scrim-lobby.ts,
 * LEAGUE_CONFIG, the season's ticket), so the steps can't drift from what
 * the importer needs.
 *
 * The password is for the two teams: the page passes it only to their
 * players, captains, coaches and admins. Everyone else reads the steps
 * without it.
 */
export function ScrimLobbyCard({
  scrimId,
  hostTeamName,
  hostCaptainName,
  awayCaptainName,
  bestOf,
  leagueId,
  password,
}: {
  scrimId: string;
  hostTeamName: string;
  hostCaptainName: string;
  awayCaptainName: string;
  bestOf: number;
  /** The season's Valve league ticket (`Season.dotaLeagueId`), if any. */
  leagueId: string | null;
  /**
   * "members-only": the viewer isn't on either team. "host-chooses": the
   * site has no secret to derive one (the host picks it).
   */
  password: { value: string } | "members-only" | "host-chooses";
}) {
  const lobbyName = scrimLobbyName(LEAGUE_CONFIG.name, scrimId);
  const host = scrimHostNote({
    hostCaptainName,
    hostTeamName,
    backupCaptainName: awayCaptainName,
  });
  const stepLabel = (text: string) => (
    <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-accent">
      {text}
    </p>
  );
  return (
    <section
      id="lobby"
      aria-labelledby="scrim-lobby-title"
      className="@container min-w-0 scroll-mt-24 overflow-hidden rounded-[var(--radius)] border border-line bg-surface shadow-sm shadow-black/10"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line-soft px-4 py-3">
        <div className="min-w-0 flex-1 basis-48">
          <h2
            id="scrim-lobby-title"
            className="text-[0.9375rem] font-semibold leading-snug text-fg"
          >
            Lobby setup
          </h2>
          <p className="mt-0.5 text-[13px] leading-relaxed text-muted [overflow-wrap:anywhere]">
            <b className="font-medium text-fg">{host.host}.</b> Set the lobby
            up this way and every game records here by itself.
          </p>
        </div>
        {leagueId ? (
          <Badge tone="success">Records with the ticket</Badge>
        ) : (
          <Badge tone="danger">No league ticket yet</Badge>
        )}
      </div>
      <ol className="grid grid-cols-1 @2xl:grid-cols-2">
        <li className="min-w-0 border-b border-line p-4 @2xl:border-r">
          {stepLabel("01 · Create the lobby")}
          <p className="text-xs text-muted">{SCRIM_LOBBY_PATH}</p>
          <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-3">
            <div className="min-w-0">
              <dt className="mb-1 text-[11px] text-muted">Lobby name</dt>
              <dd>
                <CopyChip value={lobbyName} label="lobby name" />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="mb-1 text-[11px] text-muted">Password</dt>
              <dd>
                {typeof password === "object" ? (
                  <CopyChip value={password.value} label="password" />
                ) : (
                  <p className="max-w-56 text-xs text-muted">
                    {password === "members-only"
                      ? "Shown here to both teams' players when they're signed in."
                      : "The host picks one and tells both teams."}
                  </p>
                )}
              </dd>
            </div>
          </dl>
        </li>
        <li
          className={cn(
            "min-w-0 border-b border-line p-4",
            leagueId ? "bg-accent/5" : "bg-danger/5",
          )}
        >
          {stepLabel("02 · Set the league ticket")}
          <p className="text-xs text-muted">{SCRIM_TICKET_PATH}</p>
          {leagueId ? (
            <div className="mt-3">
              <CopyChip value={leagueId} label="league ticket" />
            </div>
          ) : null}
          <p className="mt-3 text-xs text-muted [overflow-wrap:anywhere]">
            {scrimTicketNote({
              leagueId,
              inhouseTicketName: LEAGUE_CONFIG.inhouseLeagueConfigured
                ? LEAGUE_CONFIG.inhouseLeagueName
                : null,
            })}
          </p>
        </li>
        <li className="min-w-0 border-b border-line p-4 @2xl:border-b-0 @2xl:border-r">
          {stepLabel("03 · Match settings")}
          <p className="text-sm [overflow-wrap:anywhere]">
            {scrimMatchSettings({
              region: LEAGUE_CONFIG.gameServerRegion,
              mode: LEAGUE_GAME_MODE.name,
              bestOf,
            })}
          </p>
          <p className="mt-2 text-xs text-muted">
            Each new lobby gets the same name, password and ticket.
          </p>
        </li>
        <li className="min-w-0 p-4">
          {stepLabel("04 · Everyone joins")}
          <p className="text-xs text-muted">{SCRIM_JOIN_PATH}</p>
          <p className="mt-2 text-sm [overflow-wrap:anywhere]">
            Search for <span className="font-mono">{lobbyName}</span>, sit on
            your team&apos;s side, and the host starts the game.
          </p>
        </li>
      </ol>
      <p className="border-t border-line-soft px-4 py-3 text-xs text-muted [overflow-wrap:anywhere]">
        {host.backup}
      </p>
    </section>
  );
}
