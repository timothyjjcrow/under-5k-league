import Link from "next/link";
import { CHECKIN_NUDGE_THROTTLE_SECONDS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { formatLeagueMatchTime } from "@/lib/match-time";
import type { PickemControl } from "@/lib/pickem";
import type { FormResult, HeadToHead } from "@/lib/team-matches";
import { remindUnansweredCheckins } from "@/app/actions/availability";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { DiscordTag } from "@/components/discord-tag";
import { LocalTime } from "@/components/local-time";
import { PickemTray } from "@/components/pickem-pick-form";
import {
  Avatar,
  Badge,
  Card,
  CardBody,
  CardHeader,
  FormStrip,
  PlayerLink,
  RankBadge,
  RoleBadges,
  TeamCrest,
} from "@/components/ui";
import type { MatchPageMatch, MatchRosterMember } from "./load";

/** One team's column of the Matchup card, built by MatchPreview. */
export type MatchupSide = {
  teamId: string;
  name: string;
  logoUrl: string | null;
  /** Roster rows, most expensive signing first. */
  roster: MatchRosterMember[];
  /** This side's standin bookings for the match. */
  subs: MatchPageMatch["standins"];
  /** Roster players a standin covers. */
  replacedIds: ReadonlySet<string | undefined>;
  form: FormResult[];
  /** The captain, only when their handle may be shown to this viewer. */
  captain: MatchRosterMember["user"] | null;
};

/**
 * Both rosters side by side: rank, roles, recent form, each player's answer
 * for match night where the viewer may see it, the standins covering, the
 * captain's optional check-in reminder and the pick'em tray.
 */
export function MatchupCard({
  match,
  roundLabel,
  h2hRow,
  sides,
  regByUser,
  rsvpByUser,
  canSeeNamedAvailability,
  nudge,
  pick,
}: {
  match: MatchPageMatch;
  /** matchRoundLabel of this fixture, for the pick'em tray's legend. */
  roundLabel: string;
  /** The home side's record against the away side this season. */
  h2hRow: HeadToHead | undefined;
  sides: MatchupSide[];
  regByUser: Map<string, { roles: string }>;
  rsvpByUser: Map<string, string>;
  canSeeNamedAvailability: boolean;
  /** The viewing captain's check-in reminder, when they may send one. */
  nudge: { teamId: string; waiting: number; sentAt: Date | null } | null;
  pick: PickemControl | null;
}) {
  return (
    <Card id="match-matchup" className="scroll-mt-24 overflow-hidden">
      <CardHeader
        title="Matchup"
        headingLevel={2}
        subtitle={
          h2hRow && h2hRow.wins + h2hRow.losses + h2hRow.draws > 0
            ? `Prior meetings: ${
                h2hRow.wins > h2hRow.losses
                  ? `${match.homeTeam.name} lead ${h2hRow.wins}–${h2hRow.losses}`
                  : h2hRow.losses > h2hRow.wins
                    ? `${match.awayTeam.name} lead ${h2hRow.losses}–${h2hRow.wins}`
                    : `tied ${h2hRow.wins}–${h2hRow.losses}`
              }${h2hRow.draws ? ` (${h2hRow.draws} drawn)` : ""}`
            : "First meeting this season"
        }
      />
      <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {sides.map((s) => (
          <div key={s.teamId} className="rounded-lg border border-line p-3">
            {/* flex-wrap: a long name keeps its line and the form drops
                under it, rather than both squeezing. */}
            <div className="mb-2.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
              <Link
                href={`/teams/${s.teamId}`}
                className="flex min-w-0 items-center gap-2 font-display text-base font-semibold hover:text-info"
              >
                <TeamCrest
                  name={s.name}
                  seed={s.teamId}
                  logoUrl={s.logoUrl}
                  size={24}
                  className="rounded-md"
                />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {s.name}
                </span>
              </Link>
              {s.form.length > 0 ? (
                <FormStrip form={s.form} size={5} className="ml-auto" />
              ) : null}
            </div>
            {/* Its own line, not squeezed into the captain's roster row,
                which already truncates the name on a phone. */}
            {s.captain ? (
              <p className="mb-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                <span>Captain&apos;s Discord</span>
                <DiscordTag
                  name={s.captain.discordName}
                  verified={!!s.captain.discordId}
                />
              </p>
            ) : null}
            <ul className="space-y-1">
              {s.roster.map((m) => {
                const reg = regByUser.get(m.userId);
                const rsvp = rsvpByUser.get(m.userId);
                const replaced = s.replacedIds.has(m.userId);
                return (
                  <li
                    key={m.id}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-sm",
                      replaced && "opacity-50",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Avatar
                        name={m.user.name}
                        src={m.user.avatar}
                        size={22}
                      />
                      <PlayerLink userId={m.userId} className="truncate">
                        {m.user.name}
                      </PlayerLink>
                      {m.isCaptain ? <Badge tone="accent">C</Badge> : null}
                      <RankBadge rankTier={m.user.rankTier} />
                      <RoleBadges roles={reg?.roles ?? ""} />
                    </span>
                    {replaced || canSeeNamedAvailability ? (
                      <span className="shrink-0 text-xs">
                        {replaced ? (
                          <span className="text-muted">standin covers</span>
                        ) : rsvp === "IN" ? (
                          <span className="text-success">✓ in</span>
                        ) : rsvp === "OUT" ? (
                          <span className="text-danger">✗ out</span>
                        ) : (
                          <span className="text-muted">no reply</span>
                        )}
                      </span>
                    ) : null}
                  </li>
                );
              })}
              {s.subs.map((sub) => {
                // Standins RSVP like everyone else — captains need to see
                // whether the cover actually confirmed for match night.
                const subRsvp = rsvpByUser.get(sub.standin.id);
                return (
                  <li
                    key={sub.id}
                    className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-sm"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="text-xs">🔁</span>
                      <PlayerLink
                        userId={sub.standin.id}
                        className="truncate"
                      >
                        {sub.standin.name}
                      </PlayerLink>
                      <span className="truncate text-xs text-muted">
                        {sub.replaced
                          ? `in for ${sub.replaced.name}`
                          : "filling an open seat"}
                      </span>
                    </span>
                    {canSeeNamedAvailability ? (
                      <span className="shrink-0 text-xs">
                        {subRsvp === "IN" ? (
                          <span className="text-success">✓ in</span>
                        ) : subRsvp === "OUT" ? (
                          <span className="text-danger">✗ out</span>
                        ) : (
                          <span className="text-muted">no reply</span>
                        )}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {nudge && s.teamId === nudge.teamId ? (
              nudge.sentAt ? (
                <p className="mt-3 border-t border-line-soft pt-2 text-xs text-muted">
                  Check-in reminder sent{" "}
                  <LocalTime
                    ts={nudge.sentAt.getTime()}
                    variant="short"
                    initial={formatLeagueMatchTime(nudge.sentAt, "short")}
                  />
                  . You can send another from{" "}
                  <LocalTime
                    ts={
                      nudge.sentAt.getTime() +
                      CHECKIN_NUDGE_THROTTLE_SECONDS * 1000
                    }
                    variant="short"
                    initial={formatLeagueMatchTime(
                      new Date(
                        nudge.sentAt.getTime() +
                          CHECKIN_NUDGE_THROTTLE_SECONDS * 1000,
                      ),
                      "short",
                    )}
                  />
                  .
                </p>
              ) : (
                <ActionForm
                  action={remindUnansweredCheckins}
                  hidden={{ matchId: match.id }}
                  className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line-soft pt-3"
                >
                  <SubmitButton variant="secondary" size="sm">
                    {nudge.waiting === 1
                      ? "Remind the 1 who hasn't answered"
                      : `Remind the ${nudge.waiting} who haven't answered`}
                  </SubmitButton>
                  <span className="text-xs text-muted">
                    One Discord post that pings only them.
                  </span>
                </ActionForm>
              )
            ) : null}
          </div>
        ))}
      </CardBody>
      {pick ? (
        <PickemTray
          control={pick}
          matchId={match.id}
          roundLabel={roundLabel}
          home={{
            id: match.homeTeamId,
            name: match.homeTeam.name,
            logoUrl: match.homeTeam.logoUrl,
          }}
          away={{
            id: match.awayTeamId,
            name: match.awayTeam.name,
            logoUrl: match.awayTeam.logoUrl,
          }}
          locksAt={match.scheduledAt?.getTime() ?? null}
          className="border-t border-line-soft px-4 py-3"
        />
      ) : null}
    </Card>
  );
}
