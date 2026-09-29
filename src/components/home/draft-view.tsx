import Link from "next/link";
import { Fragment } from "react";
import { SteamSignInNote } from "@/components/steam-sign-in";
import {
  Card,
  CardBody,
  CardHeader,
  LinkArrow,
  PlayerLink,
  TeamCrest,
  buttonClasses,
} from "@/components/ui";
import { DRAFT_STATUS } from "@/lib/constants";
import { draftSetupOpen } from "@/lib/draft-setup";
import type { SeasonSnapshot } from "@/lib/queries";
import { draftPhasePresentation } from "@/lib/season-copy";
import { rosterOrder } from "@/lib/team-roster";
import {
  CaptainLine,
  NewcomerStandinLine,
  SignInHereButton,
  StandinSignupLink,
  YourTeamLine,
  captainContact,
} from "./hero-controls";
import { HeroStat, type HeroParts, type HomeViewer } from "./hero";

/**
 * The hero during the Draft phase: the door to the draft room, the captain's
 * line before Start, the viewer's own team once they are on one, and the late
 * standin signup for someone without a team.
 */
export async function draftHero(
  snapshot: SeasonSnapshot,
  viewer: HomeViewer,
): Promise<HeroParts> {
  const { season } = snapshot;
  const { user, isActiveReg, captaining, standinRegistrationOpen } = viewer;
  const draftPresentation = draftPhasePresentation(snapshot.draftStatus);
  // The viewer's own team, once they are on one: a player is rostered when
  // they are bought, a captain's roster is worth a line once it is final.
  const draftDone = snapshot.draftStatus === DRAFT_STATUS.COMPLETE;
  const myDraftTeam = user
    ? snapshot.teams.find((team) =>
        team.members.some((member) => member.userId === user.id),
      )
    : undefined;
  const teamLine =
    user && myDraftTeam && (myDraftTeam.captainId !== user.id || draftDone) ? (
      <YourTeamLine
        team={myDraftTeam}
        viewerId={user.id}
        teamSize={season.teamSize}
        captainContact={await captainContact(
          user,
          myDraftTeam.captainId,
          isActiveReg,
        )}
        fixturesSoon={draftDone}
      />
    ) : null;
  const action = (
    <>
      <Link href="/draft" className={buttonClasses("accent", "lg")}>
        {draftPresentation.action}
      </Link>
      {/* Before Start only: once the auction runs, the room is the
          captain's whole job and the pool is inside it. Nothing else on
          this view prints the draft time, so the line carries it. */}
      {captaining && draftSetupOpen(season.status, snapshot.draftStatus) ? (
        <CaptainLine draftAt={season.draftAt} />
      ) : null}
      {teamLine}
      {standinRegistrationOpen ? (
        user ? (
          <StandinSignupLink variant="secondary" />
        ) : (
          <>
            <SignInHereButton variant="secondary" />
            <NewcomerStandinLine />
            <SteamSignInNote />
          </>
        )
      ) : null}
    </>
  );
  const meta = (
    <HeroStat
      value={snapshot.teams.length}
      label={
        snapshot.teams.length === 1
          ? draftPresentation.teamLabelSingular
          : draftPresentation.teamLabel
      }
    />
  );
  return { action, meta };
}

/**
 * Everything below the hero in the Draft phase: while the auction runs, one
 * line pointing at the draft room, then every roster as one compact table.
 *
 * Home used to show the lot on the block, the pool count and the latest
 * sales, read once when the page loaded. The auction moves every few seconds
 * and this page never refreshes, so the lot was stale almost at once; the
 * draft room is the live view. The rosters were six tall cards of "Empty
 * slot" rows (about 390px each on a phone), with the $0 captain listed last.
 */
export function DraftPhaseView({ snapshot }: { snapshot: SeasonSnapshot }) {
  const { teams, season, draftStatus } = snapshot;
  // Budgets are real only once the auction starts: Start replaces every
  // team's placeholder with its MMR-weighted budget from the final captain
  // pool. Before that every team showed the same flat figure, one no captain
  // would actually get.
  const budgetsSet = !draftSetupOpen(season.status, draftStatus);
  const running =
    draftStatus === DRAFT_STATUS.IN_PROGRESS ||
    draftStatus === DRAFT_STATUS.PAUSED;
  return (
    <div className="space-y-6">
      {running ? (
        <Link
          href="/draft"
          className="group flex items-center justify-between gap-3 rounded-[var(--radius)] border border-line bg-surface/60 px-4 py-3 text-sm transition-colors hover:border-muted/60"
        >
          <span className="flex min-w-0 items-center gap-2.5">
            {draftStatus === DRAFT_STATUS.IN_PROGRESS ? (
              <span
                aria-hidden
                className="animate-live-pulse inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
              />
            ) : null}
            <span className="font-medium">
              {draftStatus === DRAFT_STATUS.PAUSED
                ? "The draft is paused"
                : "The draft is live"}
            </span>
          </span>
          <span className="shrink-0 font-medium text-accent group-hover:underline">
            Watch <LinkArrow />
          </span>
        </Link>
      ) : null}
      <Card className="overflow-hidden">
        <CardHeader
          headingLevel={2}
          title="Rosters"
          subtitle={`${teams.length} ${teams.length === 1 ? "team" : "teams"} · ${season.teamSize} players each`}
        />
        <CardBody className="p-0">
          <table className="w-full table-fixed text-sm">
            <caption className="sr-only">
              {budgetsSet
                ? "Each team's players, captain first, with seats filled and budget left"
                : "Each team's captain and seats filled"}
            </caption>
            <colgroup>
              <col />
              <col className="w-16" />
              {budgetsSet ? <col className="w-20 sm:w-24" /> : null}
            </colgroup>
            <thead className="text-xs text-muted">
              <tr className="border-b border-line">
                <th
                  scope="col"
                  id="draft-roster-col-team"
                  className="px-4 py-2 text-left font-medium"
                >
                  Team
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  Seats
                </th>
                {budgetsSet ? (
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Budget left
                  </th>
                ) : null}
              </tr>
            </thead>
            {/* One row group per team. The row header is the team alone: the
                roster sits in its own cell below it (Seats and Budget span
                both rows), so a screen reader names each cell by the team,
                not by the whole roster. The roster cell points back at the
                team and the Team column with `headers`. */}
            {teams.map((t, i) => (
              <tbody
                key={t.id}
                className={i > 0 ? "border-t border-line-soft" : undefined}
              >
                <tr className="align-top">
                  <th
                    scope="row"
                    id={`draft-roster-${t.id}`}
                    className="min-w-0 px-4 pt-3 text-left font-normal"
                  >
                    <Link
                      href={`/teams/${t.id}`}
                      className="flex min-w-0 items-center gap-2 font-semibold hover:text-info"
                    >
                      <TeamCrest
                        name={t.name}
                        seed={t.id}
                        logoUrl={t.logoUrl}
                        size={22}
                        className="shrink-0 rounded"
                      />
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        {t.name}
                      </span>
                    </Link>
                  </th>
                  <td rowSpan={2} className="px-2 py-3 text-right tabular-nums">
                    {t.members.length}/{season.teamSize}
                  </td>
                  {budgetsSet ? (
                    <td
                      rowSpan={2}
                      className="px-4 py-3 text-right tabular-nums"
                    >
                      ${t.budget}
                    </td>
                  ) : null}
                </tr>
                <tr className="align-top">
                  {/* leading-7: two wrapped lines of tap-safe links must not
                      overlap each other. */}
                  <td
                    headers={`draft-roster-col-team draft-roster-${t.id}`}
                    className="min-w-0 px-4 pt-1 pb-3 leading-7 text-muted [overflow-wrap:anywhere]"
                  >
                    {rosterOrder(t.members).map((m, j) => (
                      <Fragment key={m.id}>
                        {j > 0 ? ", " : null}
                        <PlayerLink userId={m.userId} className="text-fg">
                          {m.user.name}
                        </PlayerLink>
                        {m.isCaptain ? (
                          <span
                            title="Captain"
                            className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded border border-accent/40 bg-accent/15 px-1 align-middle text-[11px] font-semibold text-accent"
                          >
                            <span aria-hidden>C</span>
                            <span className="sr-only">captain</span>
                          </span>
                        ) : budgetsSet ? (
                          <span className="text-xs"> ${m.price}</span>
                        ) : null}
                      </Fragment>
                    ))}
                  </td>
                </tr>
              </tbody>
            ))}
          </table>
        </CardBody>
      </Card>
    </div>
  );
}
