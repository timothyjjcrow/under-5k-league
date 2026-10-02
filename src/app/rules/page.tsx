import { prisma } from "@/lib/prisma";
import { getActiveSeason } from "@/lib/season";
import { latestSeason } from "@/lib/season-scope";
import { announcedMatchNight, type FixtureKickoff } from "@/lib/match-night";
import { leagueRules } from "@/lib/league-rules";
import { shareMetadata } from "@/lib/share-metadata";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  PageTitle,
  textLink,
} from "@/components/ui";

// An admin's settings save changes what this page says, so it is read per
// request. Every sentence comes from leagueRules (src/lib/league-rules.ts):
// this file holds no rule numbers of its own, and league-rules.test.ts checks
// that it never starts to.
export const dynamic = "force-dynamic";

export const metadata = shareMetadata(
  "Rules",
  "Series lengths, standings and tiebreakers, forfeits, standins and match night, in one place.",
  "/rules",
);

export default async function RulesPage() {
  const active = await getActiveSeason();
  const season = active ?? (await latestSeason());
  // The match night and the playoff field are the ACTIVE season's: between
  // seasons the next season's are not known yet.
  const [fixtures, teamCount]: [FixtureKickoff[], number | null] = active
    ? await Promise.all([
        prisma.match.findMany({
          where: { seasonId: active.id, scheduledAt: { not: null } },
          select: { scheduledAt: true, status: true },
        }),
        prisma.team.count({ where: { seasonId: active.id, withdrawn: false } }),
      ])
    : [[], null];
  const rules = leagueRules({
    season,
    matchNight: announcedMatchNight(active, fixtures),
    teamCount,
  });

  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle
        title="Rules"
        subtitle={rules.basis}
        action={
          rules.defaults ? (
            <Badge tone="accent">First-season defaults</Badge>
          ) : undefined
        }
      />

      <nav aria-label="Rules sections" className="mb-5">
        <ul className="flex flex-wrap gap-x-4 gap-y-3 text-sm">
          {rules.sections.map((section) => (
            <li key={section.id} className="min-w-0">
              <a href={`#${section.id}`} className={textLink()}>
                {section.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="space-y-4">
        {rules.sections.map((section) => (
          <Card key={section.id} id={section.id} className="scroll-mt-24">
            <CardHeader title={section.title} headingLevel={2} />
            <CardBody>
              <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed [overflow-wrap:anywhere] marker:text-muted">
                {section.rules.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
            </CardBody>
          </Card>
        ))}
      </div>

      <p className="mt-6 text-sm font-semibold text-fg">{rules.closing}</p>
    </div>
  );
}
