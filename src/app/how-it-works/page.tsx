import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getActiveSeason } from "@/lib/season";
import { getSessionUser } from "@/lib/auth";
import { shareMetadata } from "@/lib/share-metadata";
import { SteamJoin } from "@/components/steam-sign-in";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import {
  LEAGUE_NAME_MEANING,
  eligibilityText,
  howItWorksAction,
  resultsCopy,
} from "@/lib/how-it-works";
import { seasonMatchNightLabel } from "@/lib/match-night";
import { leaguePitch } from "@/lib/season-copy";
import {
  Card,
  CardBody,
  CardHeader,
  DiscordButton,
  LinkArrow,
  PageTitle,
  buttonClasses,
  textLink,
} from "@/components/ui";

// The same sentence Home and the site-wide link preview open with.
const PITCH = leaguePitch();

export const metadata = shareMetadata("How it works", PITCH, "/how-it-works");

// Whether results can come in by themselves depends on the season's league
// ticket, so the last step and the recording answer are built per request
// (resultsCopy).
function steps(results: string) {
  return [
    {
      title: "Sign up",
      detail:
        "Sign in with Steam and add your roles and favorite heroes. You don't need a team: everyone signs up on their own.",
    },
    {
      title: "Draft night",
      detail:
        "Captains take turns nominating players and bid for them in a live auction. When it ends, you have a team.",
    },
    {
      title: "Weekly matches and playoffs",
      detail: `Your team plays one series every match night. ${results}`,
    },
  ];
}

function faq(recording: string) {
  return [
    {
      question: "Do I need to bring a team?",
      answer:
        "No. Everyone signs up on their own and captains build the teams in the draft. Your roles and heroes help them see where you fit.",
    },
    {
      question: "How much time does it take?",
      answer:
        "Draft night, then one match night a week for the season. If you'll miss one, press \"Can't make it\" on your match early so your captain can find a standin.",
    },
    {
      question: "How do our games get recorded?",
      answer: recording,
    },
    {
      question: "Can I follow along without playing?",
      answer:
        "Yes. Anyone can browse teams, results and player pages. Sign in with Steam to play fantasy and pick'em while they're open.",
    },
    {
      question: "Can I cast or stream league matches?",
      answer:
        "Playoff and final match pages link the league's stream channel when there is one. If you'd like to cast a match, tell an admin.",
    },
  ];
}

export default async function HowItWorksPage() {
  const [season, user] = await Promise.all([
    getActiveSeason(),
    getSessionUser(),
  ]);
  const [registration, membership, fixtures] = await Promise.all([
    season && user
      ? prisma.registration.findUnique({
          where: {
            seasonId_userId: { seasonId: season.id, userId: user.id },
          },
          select: { status: true },
        })
      : null,
    season && user
      ? prisma.teamMember.findFirst({
          where: { seasonId: season.id, userId: user.id },
          select: { teamId: true },
        })
      : null,
    // The night /me and Schedule print comes from the fixtures once they
    // have kickoffs (lib/match-night), so this page reads them too.
    season
      ? prisma.match.findMany({
          where: { seasonId: season.id, scheduledAt: { not: null } },
          select: { scheduledAt: true, status: true },
        })
      : [],
  ]);

  const results = resultsCopy(season ? !!season.dotaLeagueId : null);
  const action = howItWorksAction({
    phase: season?.status ?? null,
    seasonName: season?.name ?? null,
    signedIn: user !== null,
    registrationStatus: registration?.status ?? null,
    onRoster: membership !== null,
    hasDiscord: Boolean(LEAGUE_CONFIG.discordInviteUrl),
  });
  const button =
    action.kind === "sign-in" ? (
      <SteamJoin next={action.next} size="lg">
        {action.label} <LinkArrow />
      </SteamJoin>
    ) : action.kind === "link" ? (
      <Link href={action.href} className={buttonClasses("primary", "lg")}>
        {action.label} <LinkArrow />
      </Link>
    ) : action.kind === "discord" ? (
      <DiscordButton size="lg" />
    ) : (
      <Link href="/news" className={buttonClasses("secondary", "lg")}>
        League news <LinkArrow />
      </Link>
    );

  return (
    <div className="mx-auto max-w-5xl">
      <PageTitle
        title="How it works"
        subtitle={`${PITCH} ${LEAGUE_NAME_MEANING}`}
        action={button}
      />

      <section id="join" aria-labelledby="steps-title" className="scroll-mt-24">
        <h2 id="steps-title" className="sr-only">
          A season in three steps
        </h2>
        <ol className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {steps(results.step).map((step, index) => (
            <li key={step.title} className="min-w-0">
              <Card className="h-full">
                <CardBody>
                  <p
                    aria-hidden="true"
                    className="font-display text-sm font-semibold text-accent"
                  >
                    {index + 1}
                  </p>
                  <h3 className="mt-1 text-base font-semibold">{step.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">
                    {step.detail}
                  </p>
                </CardBody>
              </Card>
            </li>
          ))}
        </ol>
      </section>

      <Card className="mt-6">
        <CardHeader title="Before you sign up" headingLevel={2} />
        <CardBody>
          <dl className="grid grid-cols-1 gap-5 text-sm md:grid-cols-3">
            <div className="min-w-0">
              <dt className="font-semibold">Who can join</dt>
              <dd className="mt-1 leading-relaxed text-muted">
                {/* Between seasons there is no review threshold to quote:
                    each season sets its own, so only the hard ceiling,
                    which never changes, is stated. */}
                {eligibilityText(season?.maxMmr ?? 0)}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="font-semibold">When and where</dt>
              <dd className="mt-1 leading-relaxed text-muted">
                <strong className="font-semibold text-fg">
                  {seasonMatchNightLabel(season, fixtures)}
                </strong>
                . Games are on {LEAGUE_CONFIG.gameServerRegion} servers, and the
                schedule shows every kickoff in your local time.
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="font-semibold">Can&apos;t play every week?</dt>
              <dd className="mt-1 leading-relaxed text-muted">
                Register as a standin: standins cover when a team is short, and
                can register until the playoffs end. Or play{" "}
                <Link href="/inhouse" className={textLink()}>
                  inhouses
                </Link>
                , pick-up games with no season to commit to.
              </dd>
            </div>
          </dl>
        </CardBody>
      </Card>

      <Card id="faq" className="mt-6 scroll-mt-24">
        <CardHeader
          title="Questions"
          headingLevel={2}
          action={
            <Link href="/rules" className={textLink("text-sm")}>
              League rules <LinkArrow />
            </Link>
          }
        />
        <ul className="divide-y divide-line-soft">
          {faq(results.faq).map((item) => (
            <li key={item.question}>
              <details className="group">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-5 py-3 text-sm font-medium hover:bg-surface-2/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 [&::-webkit-details-marker]:hidden">
                  {item.question}
                  <span
                    aria-hidden="true"
                    className="shrink-0 text-muted transition-transform group-open:rotate-45 motion-reduce:transition-none"
                  >
                    +
                  </span>
                </summary>
                <p className="px-5 pb-4 text-sm leading-relaxed text-muted">
                  {item.answer}
                </p>
              </details>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
