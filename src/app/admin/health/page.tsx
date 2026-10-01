import type { ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { singleSearchParam } from "@/lib/search-params";
import { resolveSeasonScope } from "@/lib/season-scope";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { LEAGUE_LOCALE, zoneLabel } from "@/lib/zoned-time";
import { loadLeagueHealth } from "@/lib/league-health-service";
import {
  dayLabel,
  percent,
  weekLabel,
  type LabelledCount,
  type LeagueHealth,
} from "@/lib/league-health";
import { SeasonSwitcher } from "@/components/season-scope";
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageTitle,
  SectionTitle,
  StatCell,
  StatStrip,
  buttonClasses,
} from "@/components/ui";

export const metadata = { title: "League health" };

const number = new Intl.NumberFormat("en-US");

/**
 * League health: one season's signups, check-ins, standins, Discord reach
 * and new accounts, as counts. Server-rendered from database reads only
 * (league-health-service.ts): no names, no contact details, no client
 * payload, no Discord or OpenDota call. Admins only; anyone else gets the
 * same 404 as a page that doesn't exist.
 */
export default async function LeagueHealthPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string | string[] }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/admin/health");
  if (user.role !== "ADMIN") notFound();
  const seasonParam = singleSearchParam((await searchParams).season);
  if (seasonParam === null) notFound();
  // ?season= wins and an unknown id is a 404; without one, the active
  // season, else the most recent.
  const season = await resolveSeasonScope(seasonParam);
  const back = (
    <Link href="/admin" className={buttonClasses("secondary", "sm")}>
      Back to admin
    </Link>
  );
  if (!season) {
    return (
      <div className="space-y-6">
        <PageTitle title="League health" action={back} />
        <EmptyState
          title="No seasons yet"
          description="League health counts a season's signups, check-ins, standins and Discord posts once the first season is open."
        />
      </div>
    );
  }

  const { seasons, health } = await loadLeagueHealth(season);
  const zone = LEAGUE_CONFIG.timeZone;
  const day = (date: Date) => dayLabel(date, zone, LEAGUE_LOCALE);
  const range = health.window;
  const span = range.next
    ? `from ${day(range.start)}, when ${season.name} was created, until ${day(range.end)}, when ${range.next.name} was`
    : `since ${day(range.start)}, when ${season.name} was created`;

  return (
    <div className="space-y-6">
      <PageTitle
        title="League health"
        subtitle={`${season.name} · ${day(range.start)} to ${range.next ? day(range.end) : "today"}`}
        action={back}
      />
      <p className="text-sm text-muted">
        Counts from this league&apos;s database, to compare seasons and spot
        trends. Nothing here names a player or changes anything.
      </p>
      <SeasonSwitcher
        label="league health"
        basePath="/admin/health"
        seasons={seasons}
        selectedId={season.id}
      />
      <SignupsSection health={health} teamSize={season.teamSize} />
      <CheckinsSection health={health} teamSize={season.teamSize} />
      <StandinsSection health={health} />
      <DiscordSection health={health} span={span} />
      <AccountsSection health={health} span={span} zone={zoneLabel(zone)} />
    </div>
  );
}

/** One section: an h2, its figures, an optional breakdown, then the notes
 *  that say what the figures can and can't tell you. */
function Section({
  title,
  figures,
  children,
  notes,
}: {
  title: string;
  figures: ReactNode;
  children?: ReactNode;
  notes: string[];
}) {
  return (
    <section className="min-w-0 space-y-3">
      <SectionTitle>{title}</SectionTitle>
      <StatStrip>{figures}</StatStrip>
      {children}
      <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted [overflow-wrap:anywhere]">
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </section>
  );
}

/** A labelled list of counts inside a card, or one line saying it's empty. */
function Breakdown({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: LabelledCount[];
  empty: string;
}) {
  return (
    <Card>
      <CardHeader title={title} />
      <CardBody>
        {rows.length ? (
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-sm">
            {rows.map((row) => (
              <div key={row.key} className="contents">
                <dt className="min-w-0 text-muted">{row.label}</dt>
                <dd className="text-right font-semibold tabular-nums text-fg">
                  {number.format(row.count)}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-muted">{empty}</p>
        )}
      </CardBody>
    </Card>
  );
}

function SignupsSection({
  health,
  teamSize,
}: {
  health: LeagueHealth;
  teamSize: number;
}) {
  const s = health.signups;
  const never = s.neverDrafted;
  const neverValue =
    never.state === "counted"
      ? number.format(never.count)
      : never.state === "before-draft"
        ? "After the draft"
        : never.state === "no-draft"
          ? "No draft"
          : "Unknown";
  const neverNote =
    never.state === "counted"
      ? "Never drafted: active player signups who were never on a team this season (not a captain, not bought in the auction, not signed later)."
      : never.state === "before-draft"
        ? "Never drafted is counted once the auction is complete."
        : never.state === "no-draft"
          ? "This season ended before its auction, so nobody was drafted."
          : never.reason === "no-auction"
            ? "Never drafted is unknown: this season has no finished auction on record, so an unsold signup can't be told from one that was rostered some other way."
            : "Never drafted is unknown: this season's roster history is incomplete (part of it was recorded after the fact, or never), so a player released early may have left no record.";
  return (
    <Section
      title="Signups and seats"
      figures={
        <>
          <StatCell label="Player signups" value={number.format(s.players.active)} />
          <StatCell
            label="Seats"
            value={s.seats > 0 ? number.format(s.seats) : "None yet"}
            tone={s.seats > 0 ? "default" : "muted"}
            hint={
              s.seats > 0
                ? `${number.format(s.teams)} teams of ${teamSize}`
                : "no captains yet"
            }
          />
          <StatCell label="Withdrew" value={number.format(s.players.withdrawn)} />
          <StatCell
            label="Removed by an admin"
            value={number.format(s.players.removed)}
          />
          <StatCell
            label="Never drafted"
            value={neverValue}
            tone={never.state === "counted" ? "default" : "muted"}
          />
          <StatCell
            label="Returning"
            value={`${number.format(s.returning)} of ${number.format(s.players.active)}`}
            hint={percent(s.returning, s.players.active) ?? undefined}
          />
        </>
      }
      notes={[
        `Signups are uncapped: the target of ${s.targetTeams} teams (${number.format(s.targetSeats)} seats) is a floor. Seats count every team's full roster${s.withdrawnTeams > 0 ? `, including the ${s.withdrawnTeams} that withdrew` : ""}.`,
        "Withdrawals and removals carry no date, so these show where those signups stand now, not when they changed.",
        neverNote,
        "Returning: active player signups who also signed up for an earlier season.",
      ]}
    />
  );
}

function CheckinsSection({
  health,
  teamSize,
}: {
  health: LeagueHealth;
  teamSize: number;
}) {
  const c = health.checkins;
  const rate = percent(c.answered, c.seats);
  return (
    <Section
      title="Check-ins"
      figures={
        <>
          <StatCell label="Series kicked off" value={number.format(c.matches)} />
          <StatCell
            label="Answered"
            value={rate ?? "None yet"}
            tone={rate ? "default" : "muted"}
            hint={
              rate
                ? `${number.format(c.answered)} of ${number.format(c.seats)} seats`
                : "no series has kicked off"
            }
          />
          <StatCell label="I'm in" value={number.format(c.in)} />
          <StatCell label="Can't make it" value={number.format(c.out)} />
        </>
      }
      notes={[
        `Series whose kickoff has passed, forfeits left out. Each counts full sides of ${teamSize}, plus a seat for every standin booked on it.`,
        "A new kickoff clears check-ins, so a moved series counts only the answers given after it moved.",
      ]}
    />
  );
}

function StandinsSection({ health }: { health: LeagueHealth }) {
  const st = health.signups.standins;
  const left = [
    st.withdrawn > 0 ? `${number.format(st.withdrawn)} withdrew` : null,
    st.removed > 0 ? `${number.format(st.removed)} removed` : null,
  ].filter((part): part is string => part !== null);
  return (
    <Section
      title="Standins"
      figures={
        <>
          <StatCell
            label="Standin signups"
            value={number.format(st.active)}
            hint={left.length ? left.join(" · ") : undefined}
          />
          <StatCell label="Bookings" value={number.format(health.bookings.total)} />
        </>
      }
      notes={[
        "Lead time runs from the booking to the series' current kickoff, so a series moved after the booking is measured to its new time.",
        "A booking that was removed is deleted, so it isn't counted here.",
      ]}
    >
      <Breakdown
        title="When standins were booked"
        rows={health.bookings.total > 0 ? health.bookings.lead : []}
        empty="No standins booked this season."
      />
    </Section>
  );
}

function DiscordSection({
  health,
  span,
}: {
  health: LeagueHealth;
  span: string;
}) {
  const d = health.discord;
  return (
    <Section
      title="Discord"
      figures={
        <>
          <StatCell
            label="Rostered, Discord linked"
            value={`${number.format(d.linked)} of ${number.format(d.rostered)}`}
            hint={percent(d.linked, d.rostered) ?? undefined}
          />
          <StatCell label="League posts sent" value={number.format(d.postsTotal)} />
        </>
      }
      notes={[
        "Linked means a Discord account connected to the site, not a typed username.",
        `Posts carry no season, so these are the league channel's posts sent ${span}.`,
        "News copies and webhook tests go to Discord directly and inhouse posts have their own channel, so none of them are counted.",
      ]}
    >
      <Breakdown
        title="Posts by kind"
        rows={d.posts}
        empty="No league posts were sent in this window."
      />
    </Section>
  );
}

function AccountsSection({
  health,
  span,
  zone,
}: {
  health: LeagueHealth;
  span: string;
  zone: string;
}) {
  const a = health.accounts;
  const earlier = a.earlier;
  return (
    <Section
      title="New accounts"
      figures={
        <StatCell
          label="New accounts"
          value={number.format(a.total)}
          hint={`over ${number.format(a.weeks.length + (earlier?.weeks ?? 0))} weeks`}
        />
      }
      notes={[
        `Accounts created ${span}, in weeks starting Monday, ${zone}.`,
        ...(earlier
          ? [
              `The ${number.format(earlier.weeks)} earliest weeks are folded: ${number.format(earlier.count)} accounts between them.`,
            ]
          : []),
      ]}
    >
      <Card>
        <CardHeader title="By week" />
        <CardBody>
          {a.weeks.length ? (
            <ol className="grid gap-2 text-sm [grid-template-columns:repeat(auto-fit,minmax(min(9rem,100%),1fr))]">
              {a.weeks.map((week) => (
                <li
                  key={week.weekOf}
                  className="flex min-w-0 items-baseline justify-between gap-3 rounded-md border border-line-soft px-3 py-1.5"
                >
                  <span className="min-w-0 text-muted">
                    {weekLabel(week.weekOf, LEAGUE_LOCALE)}
                  </span>
                  <span className="font-semibold tabular-nums text-fg">
                    {number.format(week.count)}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted">No weeks in this window yet.</p>
          )}
        </CardBody>
      </Card>
    </Section>
  );
}
