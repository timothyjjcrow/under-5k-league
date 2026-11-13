import Link from "@/components/app-link";
import { LocalTime } from "@/components/local-time";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  LinkArrow,
  buttonClasses,
} from "@/components/ui";
import {
  DRAFT_STATUS,
  REGISTRATION_STATUS,
  REGISTRATION_TYPE,
} from "@/lib/constants";
import {
  bidAllowanceLine,
  draftClocks,
  draftClocksLine,
  maxBid,
  teamNeed,
} from "@/lib/draft";
import { draftBudgetsForDisplay } from "@/lib/draft-budgets";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { prisma } from "@/lib/prisma";
import type { SeasonSnapshot } from "@/lib/queries";

const USD = new Intl.NumberFormat("en-US");

/**
 * Before the auction is done there are no fixtures to run, so the page leads
 * with the draft: when it is, what the captain has to spend, how many seats
 * are left to fill and who they have bought so far. The auction itself is a
 * live room (`/draft`), so bidding and nominating stay there; this card is
 * everything a captain checks before walking in.
 *
 * The budget is the team page's number: `draftBudgetsForDisplay` projects the
 * MMR-weighted budget until Start and reads `Team.budget` (money left) after.
 */
export async function DraftDesk({
  snapshot,
  teamId,
}: {
  snapshot: SeasonSnapshot;
  teamId: string;
}) {
  const { season, draftStatus, teams } = snapshot;
  const team = teams.find((t) => t.id === teamId);
  if (!team) return null;
  const budgets = draftBudgetsForDisplay({
    seasonIsActive: season.isActive,
    seasonStatus: season.status,
    draftStatus,
    baseBudget: season.draftBudget,
    budgetMmrWeight: season.budgetMmrWeight,
    teamSize: season.teamSize,
    teams,
    // Only a projection needs the captains' MMRs (the snapshot Start takes).
    captainMmrs:
      !draftStatus || draftStatus === DRAFT_STATUS.NOT_STARTED
        ? await prisma.registration.findMany({
            where: {
              seasonId: season.id,
              status: REGISTRATION_STATUS.ACTIVE,
              type: REGISTRATION_TYPE.PLAYER,
            },
            select: { userId: true, mmr: true },
          })
        : [],
  });
  const budget = budgets.byTeam.get(team.id) ?? team.budget;
  const live =
    draftStatus === DRAFT_STATUS.IN_PROGRESS ||
    draftStatus === DRAFT_STATUS.PAUSED;
  const need = teamNeed(season.teamSize, team.members.length);
  const bought = team.members.filter((m) => !m.isCaptain);
  return (
    <Card tone="feature" id="draft" className="scroll-mt-24">
      <CardHeader
        headingLevel={2}
        title="The draft"
        subtitle={
          season.draftAt ? (
            <>
              Draft night:{" "}
              <LocalTime
                ts={season.draftAt.getTime()}
                variant="full"
                initial={formatLeagueMatchTime(season.draftAt, "full")}
              />
            </>
          ) : (
            "Draft night isn't set yet"
          )
        }
        action={
          live ? (
            <Badge tone={draftStatus === DRAFT_STATUS.PAUSED ? "neutral" : "danger"}>
              {draftStatus === DRAFT_STATUS.PAUSED ? "Paused" : "Live now"}
            </Badge>
          ) : null
        }
      />
      <CardBody className="space-y-4">
        <dl
          aria-label="Your draft"
          className="grid gap-3 text-sm [grid-template-columns:repeat(auto-fit,minmax(min(11rem,100%),1fr))]"
        >
          <Fact label={budgets.isProjected ? "Your budget" : "Budget left"}>
            <span className="font-display text-xl font-semibold tabular-nums">
              ${USD.format(budget)}
            </span>
            {budgets.isProjected ? (
              <span className="block text-xs text-muted">
                Projected from the captains&apos; MMRs; it is set when the
                draft starts.
              </span>
            ) : null}
          </Fact>
          <Fact label="Seats to fill">
            <span className="font-display text-xl font-semibold tabular-nums">
              {need}
            </span>
            <span className="block text-xs text-muted">
              {team.members.length} of {season.teamSize} on the roster
            </span>
          </Fact>
          <Fact label="Player pool">
            <span className="font-display text-xl font-semibold tabular-nums">
              {USD.format(snapshot.playerCount)}
            </span>
            <span className="block text-xs text-muted">
              signed up to be drafted
            </span>
          </Fact>
          <Fact label="Clocks">
            <span className="[overflow-wrap:anywhere]">
              {draftClocksLine(draftClocks(season))}
            </span>
          </Fact>
        </dl>
        {live && need > 0 ? (
          <p className="text-sm">
            {bidAllowanceLine({
              maxBid: maxBid(
                {
                  id: team.id,
                  budget: team.budget,
                  rosterCount: team.members.length,
                },
                season.teamSize,
              ),
              need,
            })}
          </p>
        ) : null}
        {bought.length > 0 ? (
          <div>
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
              Bought so far
            </h3>
            <ul
              aria-label="Bought so far"
              className="flex flex-wrap gap-x-4 gap-y-1 text-sm"
            >
              {bought.map((m) => (
                <li key={m.userId} className="[overflow-wrap:anywhere]">
                  {m.user.name}{" "}
                  <span className="tabular-nums text-muted">
                    ${USD.format(m.price)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Link
            href="/draft"
            className={buttonClasses(live ? "primary" : "secondary", "sm")}
          >
            {live ? "Enter the draft room" : "Draft room"} <LinkArrow />
          </Link>
          <Link href="/players" className={buttonClasses("secondary", "sm")}>
            Scout the player pool <LinkArrow />
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-line-soft bg-surface-2/30 px-3 py-2">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        {label}
      </dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
