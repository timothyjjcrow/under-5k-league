import {
  adminAttention,
  attentionTitle,
  matchAttention,
  outStandins,
  shortTeams,
  standinClashes,
} from "@/lib/admin-attention";
import Link from "@/components/app-link";
import { MATCH_STATUS } from "@/lib/constants";
import { parseFormatConfig } from "@/lib/season-format";
import {
  leagueDeliveryAttention,
  type LeagueDeliveryHealth,
} from "@/lib/league-delivery";
import { resolveChampionPresentation } from "@/lib/champion-presentation";
import { MATCH_ANCHOR, matchAnchorPath } from "@/lib/match-anchors";
import {
  Card,
  CardBody,
  CardHeader,
  LinkArrow,
  textLink,
} from "@/components/ui";
import type { AdminData, Season } from "@/components/admin/season-admin-data";
import {
  draftRostersReady,
  formatBuilderAnchor,
  seasonFormatEditState,
  unlinkedRosterFor,
} from "@/components/admin/season-admin-rules";

/**
 * Every problem on the page as one list, each line linking to the control
 * that fixes it: season-wide alarms first, then the matches to review. All of
 * it is read from the database; the Discord line is the DB count of unlinked
 * players, and the membership details stream into the Discord reach card.
 */
export function AdminAttention({
  season,
  data,
  delivery,
  automation,
  jumpItems,
}: {
  season: Season;
  data: AdminData;
  /** League post delivery: a stuck backlog or a paused webhook is a line
   *  here (leagueDeliveryAttention), linking to the Discord card. */
  delivery: LeagueDeliveryHealth | null;
  automation: string[];
  jumpItems: { id: string; label: string }[];
}) {
  const names = new Map(data.teams.map((team) => [team.id, team.name]));
  const fixture = (match: AdminData["matches"][number]) =>
    `${names.get(match.homeTeamId ?? "") ?? "TBD"} vs ${names.get(match.awayTeamId ?? "") ?? "TBD"}`;
  const openMatches = data.matches.filter(
    (match) => match.status !== MATCH_STATUS.COMPLETED,
  );
  const openIds = new Set(openMatches.map((match) => match.id));
  const matchById = new Map(data.matches.map((match) => [match.id, match]));
  const standinName = new Map(
    data.assignments.map((booking) => [
      booking.standinUserId,
      booking.standin.name,
    ]),
  );
  // Stalled or dropped league announcements lead the list, pointing at the
  // Discord card whose delivery health says which and why.
  const deliveryItems = (delivery ? leagueDeliveryAttention(delivery) : []).map(
    (text, index) => ({ key: `delivery-${index}`, text, href: "#adm-discord" }),
  );
  // A format a newer release saved: every command that builds from it refuses.
  // While the builder renders, saving a layout replaces the value; once it
  // is locked only the newer version can build from it.
  const formatMode =
    parseFormatConfig(season.formatConfig).kind === "UNREADABLE"
      ? seasonFormatEditState(season, data).mode
      : null;
  const formatItems =
    formatMode === null
      ? []
      : [
          formatMode === "LOCKED"
            ? {
                key: "format-unreadable",
                text: "This season's format was saved by a newer version of the site, so starting playoffs and scheduling tiebreakers are refused until that version is back.",
                href: "#adm-schedule",
              }
            : {
                key: "format-unreadable",
                text: `This season's format was saved by a newer version of the site, which this version can't build from: swapping groups, starting playoffs and scheduling tiebreakers are refused. ${
                  formatMode === "BUILT"
                    ? "Regenerate schedule in the season builder replaces it."
                    : "Saving a layout in the season builder, or generating the schedule from it, replaces it."
                }`,
                // The builder: its own card until the schedule card shows.
                href: formatBuilderAnchor(season, data),
              },
        ];
  const items = [
    ...deliveryItems,
    ...formatItems,
    ...adminAttention({
      seasonStatus: season.status,
      draftComplete: draftRostersReady(season, data),
      automation,
      importsNeedingReview: data.importsNeedingReview,
      feedWaitingForReview: data.feedWaiting
        .filter((row) => row.status === "NEEDS_REVIEW")
        .map((row) => row.dotaMatchId),
      shortTeams: shortTeams(data.teams, season.teamSize).map(
        ({ team, missing }) => ({ name: team.name, missing }),
      ),
      standinClashes: standinClashes(data.assignments, data.matches).map(
        (clash) => ({
          standin: standinName.get(clash.standinUserId) ?? "A standin",
          first: fixture(clash.first),
          second: fixture(clash.second),
        }),
      ),
      outStandins: outStandins(data.assignments, data.outRsvps, openIds).map(
        (out) => ({
          standin: standinName.get(out.userId) ?? "A standin",
          fixture: fixture(matchById.get(out.matchId)!),
        }),
      ),
      championIssue: resolveChampionPresentation(season, data.matches).issue,
      unlinkedSignups: data.unlinkedDiscord,
      unlinkedRostered: unlinkedRosterFor(season, data)?.length ?? 0,
    }),
  ];
  const matches = matchAttention(data.matches, data.teams);
  // A section folded into the season record, or not shown this phase, has no
  // jump target; its line still reads, just without a link.
  const sectionLabel = new Map(jumpItems.map((item) => [`#${item.id}`, item.label]));
  const standinsLabel = sectionLabel.get("#adm-standins");
  return (
    <Card id="adm-attention" className="scroll-mt-40 lg:scroll-mt-56">
      <CardHeader
        headingLevel={2}
        title={attentionTitle(season.name, items.length + matches.length)}
      />
      <CardBody className="space-y-3">
        {items.length > 0 ? (
          <ul className="space-y-2">
            {items.map((item) => {
              const label = sectionLabel.get(item.href);
              return (
                <li
                  key={item.key}
                  className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm"
                >
                  {item.text}
                  {label ? (
                    <>
                      {" "}
                      <a href={item.href} className={textLink()}>
                        {label} →
                      </a>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        {matches.length > 0 ? (
          <details open={matches.length <= 5}>
            <summary className="min-h-11 cursor-pointer text-sm font-medium">
              {matches.length} match{matches.length === 1 ? "" : "es"} to
              review
            </summary>
            {/* One ruled list, not a box per match. */}
            <ul className="divide-y divide-line-soft rounded-lg border border-line">
              {matches.map((item) => (
                <li
                  key={item.id}
                  className="px-3 py-2 text-sm"
                >
                  {/* The fixture opens the match page's Admin tools, where
                      it can be fixed; its row in Schedule & results or
                      Playoffs here holds the same controls. */}
                  <span className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
                    <Link
                      href={matchAnchorPath(item.id, MATCH_ANCHOR.admin)}
                      className={textLink()}
                    >
                      {fixture(matchById.get(item.id)!)}
                    </Link>
                    <a href={`#adm-match-${item.id}`} className={textLink("text-xs")}>
                      Result controls ↓
                    </a>
                  </span>
                  <p className="mt-0.5 text-muted">
                    {item.reasons.join(" · ")}
                    {item.uncovered > 0 && standinsLabel ? (
                      <>
                        {" "}
                        <a href="#adm-standins" className={textLink()}>
                          {standinsLabel} →
                        </a>
                      </>
                    ) : null}
                  </p>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {/* inline-flex min-h-6: on 12px text TAP_SAFE alone left a 22px
            target, under the 24px minimum. gap-y-2 keeps 8px between the
            two links when they wrap. */}
        <p className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
          <Link
            href={`/admin/data-quality?season=${season.id}`}
            className={textLink("inline-flex min-h-6 items-center")}
          >
            Check imported-game quality <LinkArrow />
          </Link>
          <Link
            href={`/admin/health?season=${season.id}`}
            className={textLink("inline-flex min-h-6 items-center")}
          >
            League health <LinkArrow />
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}
