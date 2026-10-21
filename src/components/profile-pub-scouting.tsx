import {
  Card,
  CardBody,
  CardHeader,
  RankMedal,
  RoleBadges,
} from "@/components/ui";
import {
  claimedRoleLean,
  pubLobbyRead,
  pubModeRead,
  pubRegionRead,
  pubRoleRead,
  roleClaimDiffers,
  type PubModeShare,
  type PubScout,
} from "@/lib/pub-scout";
import { rankMedalName } from "@/lib/rank";
import { parseRoles } from "@/lib/roles";
import { cn } from "@/lib/utils";

const groupedNumber = new Intl.NumberFormat("en-US");

/** One colour per mode, from the tokens globals.css defines. */
const MODE_TONE: Record<PubModeShare["key"], string> = {
  ranked: "bg-info",
  unranked: "bg-success",
  turbo: "bg-accent",
  other: "bg-muted",
};

/**
 * How they play their public games, for the captains scouting them: the side
 * they play (set beside the positions on their signup), the level of their
 * lobbies, their servers and how much is ranked or Turbo. Every fact comes
 * from the stored snapshot's counts (pub-scout.ts) and shows only with enough
 * games behind it; the page renders the card only when one does.
 */
export function ProfilePubScouting({
  scout,
  roles,
  checkedLabel,
}: {
  scout: PubScout;
  /** The roles string on their active signup: what they say they play. */
  roles: string | null | undefined;
  /** How long ago the snapshot was taken ("3d ago"). */
  checkedLabel: string | null;
}) {
  const role = pubRoleRead(scout);
  const lobby = pubLobbyRead(scout);
  const modes = pubModeRead(scout);
  const regions = pubRegionRead(scout);
  const claimed = parseRoles(roles);
  const differs = roleClaimDiffers(claimedRoleLean(claimed), role);
  return (
    <Card id="player-scouting" className="min-w-0 scroll-mt-40">
      <CardHeader
        title="Pub scouting"
        subtitle={`Their last ${scout.games} public games on OpenDota${
          checkedLabel ? ` · checked ${checkedLabel}` : ""
        }`}
      />
      <CardBody className="space-y-4">
        {/* auto-fit, never grid-cols-1: the card has one to three facts. */}
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(11rem,100%),1fr))]">
          {role ? (
            <Fact label="Plays">
              <div
                className={cn(
                  "font-display text-lg font-semibold",
                  differs ? "text-accent" : "text-fg",
                )}
              >
                {role.label}
              </div>
              <div className="text-xs text-muted">
                {role.support} support · {role.core} core games
              </div>
              {claimed.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                  <span>Signed up for</span>
                  <RoleBadges roles={roles} labelled />
                </div>
              ) : null}
              {differs ? (
                <div className="text-xs text-accent">
                  Not the side their signup lists
                </div>
              ) : null}
            </Fact>
          ) : null}
          {lobby ? (
            <Fact label="Lobbies">
              <div className="flex items-center gap-2">
                <RankMedal rankTier={lobby.rankTier} size={28} />
                <span className="font-display text-lg font-semibold tabular-nums text-fg">
                  ≈{groupedNumber.format(lobby.mmr)}
                </span>
              </div>
              <div className="text-xs text-muted">
                Average medal {rankMedalName(lobby.rankTier)} over {lobby.games}{" "}
                games
              </div>
            </Fact>
          ) : null}
          {regions ? (
            <Fact label="Servers">
              {regions.map((r, i) => (
                <div
                  key={r.region}
                  className={cn(
                    "tabular-nums",
                    i === 0
                      ? "font-display text-lg font-semibold text-fg"
                      : "text-sm text-muted",
                  )}
                >
                  {r.name} {r.percent}%
                </div>
              ))}
            </Fact>
          ) : null}
        </div>
        {modes ? <ModeShares modes={modes} /> : null}
        <p className="text-xs text-muted">
          Core or support is read from last hits a minute in ranked and unranked
          games of 10+ minutes; lobbies are the average medal of those games.
        </p>
      </CardBody>
    </Card>
  );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1 rounded-lg border border-line-soft bg-surface-2/30 px-4 py-3">
      <div className="text-xs font-medium text-muted">{label}</div>
      {children}
    </div>
  );
}

/** A bar of their game modes with its legend; the bar is a picture of the
 *  legend, so it carries the same words as its name. */
function ModeShares({ modes }: { modes: PubModeShare[] }) {
  const summary = modes.map((m) => `${m.percent}% ${m.label}`).join(", ");
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-muted">Game modes</div>
      <div
        role="img"
        aria-label={`Game modes: ${summary}`}
        className="flex h-2 overflow-hidden rounded-full bg-surface-2"
      >
        {modes.map((m) => (
          <span
            key={m.key}
            className={MODE_TONE[m.key]}
            style={{
              width: `${(m.games / modes.reduce((s, x) => s + x.games, 0)) * 100}%`,
            }}
          />
        ))}
      </div>
      <div
        className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted"
        aria-hidden
      >
        {modes.map((m) => (
          <span
            key={m.key}
            className="inline-flex items-center gap-1.5 tabular-nums"
          >
            <span className={cn("h-2 w-2 rounded-full", MODE_TONE[m.key])} />
            {m.percent}% {m.label}
          </span>
        ))}
      </div>
    </div>
  );
}
