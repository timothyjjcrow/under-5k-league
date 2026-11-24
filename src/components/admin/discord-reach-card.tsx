import { Suspense } from "react";
import { prisma } from "@/lib/prisma";
import { REGISTRATION_STATUS, REGISTRATION_TYPE } from "@/lib/constants";
import { ChaseCopy } from "@/components/chase-copy";
import { ReturningCopy } from "@/components/returning-copy";
import { loadReturningPlayers } from "@/lib/returning-players-service";
import {
  getDiscordReachFunnel,
  type DiscordReachFunnel,
} from "@/lib/discord-roles";
import { Card, CardBody, CardHeader } from "@/components/ui";

/**
 * Who league announcements and pings can reach, who they can't, and one post
 * that chases the rest. Only the webhooks and bot setup stay in the collapsed
 * Discord notifications section.
 */
export async function DiscordReachCard({
  seasonId,
  rosterUnlinked,
  signupsSeasonName,
}: {
  seasonId: string;
  /** Once rosters are set: who Needs attention counts (unlinkedRosterFor). */
  rosterUnlinked: string[] | null;
  /** The season's name while it takes signups: the returning-player line. */
  signupsSeasonName: string | null;
}) {
  const reach = await getDiscordReachFunnel(seasonId);
  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="Discord reach"
        subtitle="Who league mentions and pings reach, and who to chase."
      />
      <CardBody>
        {reach.registered > 0 ? (
          <DiscordReachLine reach={reach} rosterUnlinked={rosterUnlinked} />
        ) : rosterUnlinked && rosterUnlinked.length > 0 ? (
          // Rosters can exist with no active signup behind them (a hand-run
          // league, a fixture). Needs attention counts these same people and
          // links here, so the card must name them rather than say nobody
          // has signed up.
          <div>
            <p className="text-sm">
              <b>{rosterUnlinked.length}</b> rostered{" "}
              {rosterUnlinked.length === 1
                ? "player or standin hasn't"
                : "players and standins haven't"}{" "}
              linked Discord, so pings can&apos;t reach them:{" "}
              {cappedNames(rosterUnlinked)}
            </p>
            <p className="mt-1 text-xs text-muted">
              Nobody has an active signup for this season, so there&apos;s no
              signed-up count to compare against.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted">
            Nobody has signed up for this season yet.
          </p>
        )}
        {signupsSeasonName ? (
          <Suspense fallback={null}>
            <ReturningPlayersLine
              seasonId={seasonId}
              seasonName={signupsSeasonName}
            />
          </Suspense>
        ) : null}
      </CardBody>
    </Card>
  );
}

/**
 * During signups: how many of last season's players are back, who isn't,
 * and a one-click reminder to paste into Discord. The one-tap rejoin card on
 * /me means the gap is reaching them, not the form. Database reads only; the
 * admin's paste is the send, so the site never mass-mentions anyone itself.
 */
async function ReturningPlayersLine({
  seasonId,
  seasonName,
}: {
  seasonId: string;
  seasonName: string;
}) {
  const [players, signedUp] = await Promise.all([
    loadReturningPlayers(seasonId),
    prisma.registration.count({
      where: {
        seasonId,
        status: REGISTRATION_STATUS.ACTIVE,
        type: REGISTRATION_TYPE.PLAYER,
      },
    }),
  ]);
  if (!players || players.previous === 0) return null;
  const linked = players.notBack.filter((player) => player.discordId).length;
  return (
    <div className="mt-4 border-t border-line-soft pt-3">
      <p className="text-sm">
        <b>
          {players.back} of {players.previous}
        </b>{" "}
        {players.previousSeasonName} players have signed up for {seasonName}.
      </p>
      {players.notBack.length > 0 ? (
        <>
          <p className="mt-1 text-xs text-muted">
            Not back yet ({players.notBack.length}, {linked} with Discord
            linked): {cappedNames(players.notBack.map((player) => player.name))}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ReturningCopy
              players={players}
              seasonName={seasonName}
              signedUp={signedUp}
            />
            <span className="text-xs text-muted">
              One Discord post: it mentions the {linked} with Discord linked
              (your paste pings them) and names the rest. Their answers carry
              over, so rejoining is one tap on My account.
            </span>
          </div>
        </>
      ) : (
        <p className="mt-1 text-xs text-success">
          Everyone from {players.previousSeasonName} is back.
        </p>
      )}
    </div>
  );
}

/** A name list the card caps at 12, so an unlinked league isn't a wall of names. */
function cappedNames(names: string[]): string {
  return (
    names.slice(0, 12).join(", ") +
    (names.length > 12 ? ` +${names.length - 12} more` : "")
  );
}

/**
 * The denominator under every notification the league sends. Personal
 * mentions, the un-RSVP'd ping and the opt-in role all silently skip anyone
 * who never linked Discord — so this is the number that says whether that
 * machinery reaches the league or a handful of people.
 *
 * With a bot configured it also renders the step linking cannot prove: who is
 * actually IN the server. A linked non-member is the deceptive cohort — they
 * wear the verified ✓ on every roster while every mention misses them — and
 * chasing them BEFORE the draft is the whole point of the funnel, because
 * after it they're on rosters that need to schedule with them.
 */
function DiscordReachLine({
  reach,
  rosterUnlinked,
}: {
  reach: DiscordReachFunnel;
  rosterUnlinked: string[] | null;
}) {
  const pct = Math.round((reach.linked / reach.registered) * 100);
  // Below half, the useful next move is chasing links rather than building
  // more notification machinery — so say so rather than just showing a number.
  const thin = pct < 50;
  const g = reach.linked > 0 ? reach.guild : null;
  // The funnel's lists are uncapped (the chase message names everyone); the
  // CARD caps them (cappedNames).
  const capped = cappedNames;
  // Guild lists render "name (@linked-handle)" — the membership check is
  // about the LINKED ACCOUNT, and the handle is what lets an admin verify a
  // "missing" verdict against the member list in seconds (an alt-account
  // link reads as "the site is wrong" without it).
  const cappedPlayers = (list: { name: string; handle: string }[]) =>
    list
      .slice(0, 12)
      .map((p) => (p.handle ? `${p.name} (@${p.handle})` : p.name))
      .join(", ") + (list.length > 12 ? ` +${list.length - 12} more` : "");
  const anyoneToChase =
    reach.registered - reach.linked > 0 ||
    (g !== null && (g.missing > 0 || g.pending > 0));
  return (
    <div>
      <p className="text-sm">
        <b>
          {reach.linked} of {reach.registered}
        </b>{" "}
        registered players have linked Discord{" "}
        <span className={thin ? "text-danger" : "text-success"}>({pct}%)</span>
      </p>
      <p className="mt-1 text-xs text-muted">
        {thin
          ? "Mentions and pings reach only these players — everyone else is named as plain text and never notified. Worth chasing links before adding more notifications."
          : "Everyone else is still named in announcements, just not notified."}
      </p>
      {/* After the draft, match-night pings go to rosters and booked cover.
          These are the people Needs attention counts; the full list below
          also holds idle standins and undrafted signups. */}
      {rosterUnlinked && rosterUnlinked.length > 0 ? (
        <p className="mt-1 text-xs">
          <span className="font-medium">
            On a roster or booked as cover, not linked ({rosterUnlinked.length}):
          </span>{" "}
          {capped(rosterUnlinked)}
        </p>
      ) : null}
      {reach.unlinkedNames.length > 0 ? (
        <p className="mt-1 text-xs text-muted">
          {rosterUnlinked ? "Everyone not linked" : "Not linked"}:{" "}
          {capped(reach.unlinkedNames)}
        </p>
      ) : null}
      {g ? (
        <>
          {/* When Discord answered for NOBODY, a bold "0 of 8 are in the
              server" is a membership claim the data doesn't support — render
              only the honest couldn't-check line below. With partial answers,
              the denominator is the players we could actually check.
              "Pingable" (not "in the server") is deliberate: pending members
              ARE in the server, which made the old headline contradict the
              rules-pending sub-line two rows down. */}
          {g.unknown < reach.linked ? (
            <p className="mt-2 border-t border-line-soft pt-2 text-sm">
              <b>
                {g.inServer} of {reach.linked - g.unknown}
              </b>{" "}
              {g.unknown > 0
                ? "linked players we could check are in the Discord server and pingable"
                : "linked players are in the Discord server and pingable"}
              {g.missing > 0 ? (
                <span className="text-danger"> — {g.missing} missing</span>
              ) : g.unknown === 0 && g.pending === 0 ? (
                <span className="text-success"> — all of them</span>
              ) : null}
            </p>
          ) : null}
          {g.missing > 0 ? (
            <p className="mt-1 text-xs text-danger">
              Linked account NOT in the server: {cappedPlayers(g.missingNames)}
              {/* Quoted string: JSX line-trimming eats a plain leading space
                  after an expression across a source-line break — the same
                  bug the couldn't-check line documents below. */}
              {
                " — pings to them land nowhere. If a player insists they're in the server, search the @handle in the member list: they likely linked a different account than the one they use, and the fix is re-linking from their My account page."
              }
            </p>
          ) : null}
          {g.pending > 0 ? (
            <p className="mt-1 text-xs text-muted">
              In the server but haven&apos;t accepted its rules (unpingable
              until they do): {cappedPlayers(g.pendingNames)}
            </p>
          ) : null}
          {g.unknown > 0 ? (
            <p className="mt-1 text-xs text-muted">
              {/* The quoted-string form matters twice over: JSX line-trimming
                  eats a plain leading space across a source-line break
                  (rendering "1— Discord"), and the copy must not promise a fix
                  it can't deliver — "reload" is a no-op inside the 30s memo
                  window, and a wrong guild id or kicked bot answers this way
                  FOREVER; the bot checklist is what names the broken piece. */}
              Couldn&apos;t check {g.unknown}
              {
                " — Discord didn't answer. A hiccup clears itself within a minute; if this persists, the bot checklist under Discord notifications says which piece is broken."
              }
            </p>
          ) : null}
        </>
      ) : null}
      {anyoneToChase ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ChaseCopy reach={reach} />
          <span className="text-xs text-muted">
            {/* Honest about the reach: a channel post lands with the linked
                members — the not-in-server names WON'T see it, so it asks
                teammates to relay and gives the admin the list to DM. */}
            Builds the lists above into one Discord post. Players not in the
            server won&apos;t see it — DM them the invite, or let teammates
            relay it.
          </span>
        </div>
      ) : null}
    </div>
  );
}
