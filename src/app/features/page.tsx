import Link from "next/link";
import type { ReactNode } from "react";
import { prisma } from "@/lib/prisma";
import { getActiveSeason } from "@/lib/season";
import { getSessionUser } from "@/lib/auth";
import { shareMetadata } from "@/lib/share-metadata";
import { DiscordButton, buttonClasses } from "@/components/ui";
import {
  HARD_MMR_CEILING,
  REGISTRATION_STATUS,
  REGISTRATION_TYPE,
  SOFT_MMR_LIMIT,
} from "@/lib/constants";
import { LEAGUE_CONFIG } from "@/lib/league-config";
import { resolveChampionPresentation } from "@/lib/champion-presentation";
import {
  featureAvailability,
  featuresClosingPresentation,
  type FeatureAvailability,
  type FeatureGate,
} from "@/lib/features-lifecycle";
import { draftPhasePresentation } from "@/lib/season-copy";
import { FeatureDirectory } from "./feature-directory";
import { TOUR_GROUPS } from "./tour-content";
import {
  DraftPreview,
  MatchPreview,
  RacePreview,
  ReportPreview,
} from "./tour-previews";
import styles from "./features.module.css";

export const metadata = shareMetadata(
  "Feature tour",
  `Find your team in ${LEAGUE_CONFIG.name}. Explore the auction draft, weekly Dota 2 matches, player stats, scouting, fantasy, inhouses, and the stories that stay with every season.`,
  "/features",
);

const CHAPTERS = [
  { id: "draft", label: "The draft" },
  { id: "match-night", label: "Match night" },
  { id: "your-game", label: "Your game" },
  { id: "more-dota", label: "More Dota" },
  { id: "history", label: "The history" },
  { id: "all-features", label: "All features" },
  { id: "join", label: "How to join" },
];

function TourLink({
  href,
  children,
  availability,
}: {
  href: string;
  children: ReactNode;
  availability?: FeatureAvailability;
}) {
  return !availability || availability.available ? (
    <Link href={href} prefetch={false} className={styles.textLink}>
      {children}
      <span aria-hidden="true">↗</span>
    </Link>
  ) : (
    <p className={styles.comingUp}>{availability.unavailableReason}</p>
  );
}

function ChapterHeading({
  number,
  eyebrow,
  id,
  children,
}: {
  number: string;
  eyebrow: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <>
      <p className={styles.eyebrow}>
        <span>{number}</span>
        {eyebrow}
      </p>
      <h2 id={id} className={styles.chapterTitle}>
        {children}
      </h2>
    </>
  );
}

function Highlights({ items }: { items: { title: string; detail: string }[] }) {
  return (
    <dl className={styles.highlights}>
      {items.map((item) => (
        <div key={item.title}>
          <dt>{item.title}</dt>
          <dd>{item.detail}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function FeaturesPage() {
  const [season, user] = await Promise.all([
    getActiveSeason(),
    getSessionUser(),
  ]);
  const [players, games, seasonsRun, seasonRecords, draft, registration] =
    await Promise.all([
      // Count participation rather than every account created through Steam.
      prisma.user.count({
        where: {
          OR: [
            { registrations: { some: { type: REGISTRATION_TYPE.PLAYER } } },
            { teamMemberships: { some: {} } },
            { inhouseLobbies: { some: {} } },
          ],
        },
      }),
      prisma.game.count(),
      prisma.season.count({
        where: {
          OR: [
            { status: "COMPLETE" },
            { matches: { some: { games: { some: {} } } } },
          ],
        },
      }),
      prisma.season.findMany({
        select: {
          status: true,
          championTeamId: true,
          matches: {
            where: { phase: { in: ["PLAYOFF", "FINAL"] } },
            select: {
              id: true,
              phase: true,
              bracketSlot: true,
              status: true,
              winnerTeamId: true,
              homeTeamId: true,
              awayTeamId: true,
            },
          },
        },
      }),
      season
        ? prisma.draft.findUnique({
            where: { seasonId: season.id },
            select: { status: true },
          })
        : Promise.resolve(null),
      season && user
        ? prisma.registration.findUnique({
            where: {
              seasonId_userId: { seasonId: season.id, userId: user.id },
            },
            select: { status: true, type: true },
          })
        : Promise.resolve(null),
    ]);
  const champions = seasonRecords.filter(
    (record) =>
      resolveChampionPresentation(record, record.matches).championTeamId !=
      null,
  ).length;
  const phase = season?.status ?? null;
  const draftStatus = draft?.status ?? null;
  const hasActivePlayerSignup =
    registration?.status === REGISTRATION_STATUS.ACTIVE &&
    registration.type === REGISTRATION_TYPE.PLAYER;
  const closing = featuresClosingPresentation(
    phase,
    !!user,
    hasActivePlayerSignup,
  );
  const availability = (gate: FeatureGate) =>
    featureAvailability(gate, phase, draftStatus);
  const groups = TOUR_GROUPS.map((group) => ({
    ...group,
    features: group.features.map((feature) => ({
      ...feature,
      availability: availability(feature.gate ?? "ALWAYS"),
    })),
  }));
  const regionName = LEAGUE_CONFIG.region === "eu" ? "Europe" : "United States";
  const softLimit = season?.maxMmr ?? SOFT_MMR_LIMIT;
  const phaseLabel =
    phase === "DRAFT"
      ? draftPhasePresentation(draftStatus).badge
      : ((
          {
            SIGNUPS: "Signups open",
            REGULAR_SEASON: "Regular season",
            PLAYOFFS: "Playoffs",
            COMPLETE: "Season complete",
          } as Record<string, string>
        )[phase ?? ""] ?? "Between seasons");
  const numbers = [
    { label: "league players", value: players },
    { label: "games recorded", value: games },
    { label: "seasons played", value: seasonsRun },
    { label: "champions crowned", value: champions },
  ].filter((number) => number.value > 0);

  return (
    <div className={styles.tour}>
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>
            {LEAGUE_CONFIG.name}
            <span aria-hidden="true">/</span>THE FEATURE TOUR
          </p>
          <h1>
            Your team.
            <br />
            Your season.
            <br />
            <span>Your kind of Dota.</span>
          </h1>
          <p className={styles.heroDescription}>
            The same five players. A match to prepare for. A season to make
            something of. Join an amateur Dota 2 league where the games add up
            to more than your next rank.
          </p>
          <div className={styles.heroActions}>
            {closing.action ? (
              <Link
                href={closing.action.href}
                className={buttonClasses("accent", "lg", styles.primaryAction)}
              >
                {closing.action.label}
              </Link>
            ) : (
              <Link
                href="/inhouse"
                className={buttonClasses("accent", "lg", styles.primaryAction)}
              >
                Find an inhouse game <span aria-hidden="true">→</span>
              </Link>
            )}
            <a href="#join" className={styles.heroSecondary}>
              How to join <span aria-hidden="true">↓</span>
            </a>
          </div>
          <p className={styles.heroFootnote}>
            Sign up as a player. Meet your team on draft night.
          </p>
        </div>
        <div className={styles.heroVisual}>
          <div className={styles.visualCaption}>
            <span>FROM THE FIRST BID TO THE FINAL ANCIENT</span>
            <span aria-hidden="true">↘</span>
          </div>
          <MatchPreview />
          <div className={styles.visualAfterword}>
            <span aria-hidden="true">01 — 05</span>
            <p>
              A team to play with.
              <br />
              <strong>A whole league to be part of.</strong>
            </p>
          </div>
        </div>
      </header>

      <div className={styles.leagueStrip} aria-label="Your league">
        <div>
          <span>YOUR LEAGUE</span>
          <strong>
            {regionName} · {LEAGUE_CONFIG.gameServerRegion}
          </strong>
        </div>
        <div>
          <span>MATCH NIGHT</span>
          <strong>{LEAGUE_CONFIG.matchSchedule.label}</strong>
        </div>
        <Link href="/" className={styles.seasonStatus}>
          <span>{season?.name ?? LEAGUE_CONFIG.name}</span>
          <strong>
            <i aria-hidden="true" />
            {phaseLabel}
            <span aria-hidden="true">↗</span>
          </strong>
        </Link>
      </div>
      <nav className={styles.tourNav} aria-label="Feature tour chapters">
        <div>
          {CHAPTERS.map((chapter) => (
            <a key={chapter.id} href={`#${chapter.id}`}>
              {chapter.label}
            </a>
          ))}
        </div>
      </nav>

      <section
        id="draft"
        aria-labelledby="draft-title"
        className={styles.chapter}
      >
        <div className={styles.chapterCopy}>
          <ChapterHeading number="01" eyebrow="FIND YOUR FIVE" id="draft-title">
            The season starts
            <br />
            with a paddle raised.
          </ChapterHeading>
          <p className={styles.chapterIntro}>
            You bring your hero pool, your preferred roles, and a little
            ambition. Captains bring a budget. Auction night turns a room full
            of individual players into the teams you’ll spend the season getting
            to know.
          </p>
          <Highlights
            items={[
              {
                title: "Give captains something to go on",
                detail:
                  "Roles, favorite heroes, public notes, and available match history put a player behind the MMR.",
              },
              {
                title: "Follow every nomination and bid",
                detail:
                  "Watch teams take shape in the live draft room. Captain budgets account for differences in MMR.",
              },
              {
                title: "Make the team your own",
                detail:
                  "A roster, a name, a logo, and a team page that follows your run. The draft recap keeps every signing on record.",
              },
            ]}
          />
          <div className={styles.chapterLinks}>
            <TourLink href="/players">Meet the player pool</TourLink>
            <TourLink href="/draft" availability={availability("DRAFT_ROOM")}>
              Follow the auction
            </TourLink>
          </div>
        </div>
        <DraftPreview />
      </section>

      <section
        id="match-night"
        aria-labelledby="match-night-title"
        className={`${styles.chapter} ${styles.matchChapter}`}
      >
        <div className={styles.wideHeading}>
          <ChapterHeading
            number="02"
            eyebrow="SOMETHING TO PLAY FOR"
            id="match-night-title"
          >
            Put match night on the calendar.
          </ChapterHeading>
          <p className={styles.chapterIntro}>
            A familiar roster changes the game. You can plan a draft, learn from
            last week, and come back with an answer. The site keeps the
            schedule, preparation, and results together.
          </p>
        </div>
        <ol className={styles.matchSteps}>
          <li>
            <span className={styles.stepNumber}>BEFORE THE HORN</span>
            <h3>Come prepared.</h3>
            <p>
              Scout comfort picks and opponent tendencies. Check in, arrange
              cover, and find your kickoff in local time. Add the season
              calendar so match night stays on your radar.
            </p>
          </li>
          <li>
            <span className={styles.stepNumber}>IN THE LOBBY</span>
            <h3>Get your five ready.</h3>
            <p>
              Your match center holds the roster checklist and lobby setup.
              Captains can coordinate a reschedule when needed, with both sides
              working from the same fixture.
            </p>
          </li>
          <li>
            <span className={styles.stepNumber}>AFTER THE ANCIENT</span>
            <h3>See what changed.</h3>
            <p>
              Imported games become box scores, MVPs, and updated standings.
              Open the series to see the individual performances behind the
              result.
            </p>
          </li>
        </ol>
        <div className={styles.raceSection}>
          <RacePreview />
          <div>
            <h3>
              The table has a story.
              <br />
              Know your part in it.
            </h3>
            <p>
              Follow points, head-to-head results, and team power rankings. As
              the season tightens, explore the results your team needs to
              qualify and the ties that still need settling.
            </p>
            <p>
              Then it’s the knockout bracket: a path through playoffs, a grand
              final, and one team left standing.
            </p>
            <TourLink
              href="/schedule"
              availability={availability("REGULAR_RESULTS")}
            >
              Explore the competition
            </TourLink>
          </div>
        </div>
      </section>

      <section
        id="your-game"
        aria-labelledby="your-game-title"
        className={`${styles.chapter} ${styles.analysisChapter}`}
      >
        <ReportPreview />
        <div className={styles.chapterCopy}>
          <ChapterHeading
            number="03"
            eyebrow="GET TO KNOW YOUR GAME"
            id="your-game-title"
          >
            There’s more to
            <br />a game than the score.
          </ChapterHeading>
          <p className={styles.chapterIntro}>
            Maybe your farming is excellent, but the damage isn’t there yet.
            Maybe your best games start with a support pick nobody bans. The
            numbers give you somewhere to look.
          </p>
          <Highlights
            items={[
              {
                title: "Read your performance in context",
                detail:
                  "Hero report cards use available OpenDota benchmarks to compare your game with others on the same hero.",
              },
              {
                title: "Find the patterns",
                detail:
                  "Explore the league’s hero meta, stat leaders, and weekly honors. See the sample behind a win rate before drawing conclusions.",
              },
              {
                title: "Build a career you can revisit",
                detail:
                  "Profiles collect your teams, results, hero pool, achievements, and records. Compare careers or look up a familiar rival.",
              },
            ]}
          />
          <div className={styles.chapterLinks}>
            <TourLink href="/players/compare">Compare players</TourLink>
            <TourLink
              href="/meta"
              availability={availability("REGULAR_RESULTS")}
            >
              Explore the hero meta
            </TourLink>
          </div>
        </div>
      </section>

      <section
        id="more-dota"
        aria-labelledby="more-dota-title"
        className={styles.playChapter}
      >
        <ChapterHeading
          number="04"
          eyebrow="STAY FOR ANOTHER GAME"
          id="more-dota-title"
        >
          Your week has room for more Dota.
        </ChapterHeading>
        <p className={styles.chapterIntro}>
          Practice with your roster, find a pickup game, or give yourself a
          reason to follow every other team. There’s more than one way to be
          involved.
        </p>
        <div className={styles.playGrid}>
          <article className={styles.inhouseCard}>
            <div className={styles.playCardTop}>
              <span>THE PICKUP GAME</span>
              <span aria-hidden="true">↗</span>
            </div>
            <h3>
              Good games.
              <br />
              Familiar names.
            </h3>
            <p>
              Queue for inhouses, accept the ready check, choose captains, and
              draft sides. Build an Elo record with the community, even between
              seasons.
            </p>
            <ol className={styles.queueSteps} aria-label="How inhouses work">
              <li>Queue</li>
              <li>Ready check</li>
              <li>Draft</li>
              <li>Play</li>
            </ol>
            <TourLink href="/inhouse">Find an inhouse</TourLink>
          </article>
          <article className={styles.playCard}>
            <div className={styles.playCardTop}>
              <span>THE PRACTICE ROOM</span>
              <span aria-hidden="true">02</span>
            </div>
            <h3>Try it in a scrim.</h3>
            <p>
              Post a time, book another team, and practice with a purpose.
              Coaches and casual guests can take part, with practice results and
              stats kept separate from the league table.
            </p>
            <TourLink
              href="/scrims"
              availability={availability("POST_AUCTION")}
            >
              Browse scrims
            </TourLink>
          </article>
          <article className={styles.playCard}>
            <div className={styles.playCardTop}>
              <span>YOUR OTHER STARTING FIVE</span>
              <span aria-hidden="true">03</span>
            </div>
            <h3>Build a fantasy roster.</h3>
            <p>
              Spend an MMR salary cap on five drafted players. Score from their
              real games, with contributions from economy, playmaking, and
              pressure. You can manage a five without being on a league team.
            </p>
            <TourLink
              href="/fantasy"
              availability={availability("POST_AUCTION")}
            >
              Explore fantasy
            </TourLink>
          </article>
          <article className={styles.playCard}>
            <div className={styles.playCardTop}>
              <span>CALL IT BEFORE IT HAPPENS</span>
              <span aria-hidden="true">04</span>
            </div>
            <h3>Make your picks.</h3>
            <p>
              Choose the winners, see how the community voted, and climb the
              oracle board. In inhouses, you can also back your own side with
              Cred and track your net winnings.
            </p>
            <TourLink
              href="/pickem"
              availability={availability("POST_AUCTION")}
            >
              Explore pick’em
            </TourLink>
          </article>
        </div>
      </section>

      <section
        id="history"
        aria-labelledby="history-title"
        className={styles.historyChapter}
      >
        <div className={styles.historyMark} aria-hidden="true">
          <svg
            viewBox="0 0 100 100"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M32 15h36v26c0 17-8 26-18 26S32 58 32 41V15Z" />
            <path d="M32 24H18v13c0 12 8 19 20 19m30-32h14v13c0 12-8 19-20 19M50 67v16M34 88h32M40 83h20" />
            <path d="m50 29 3.6 7.3 8.1 1.2-5.9 5.7 1.4 8.1-7.2-3.8-7.2 3.8 1.4-8.1-5.9-5.7 8.1-1.2L50 29Z" />
          </svg>
          <span>THE NEXT CHAPTER IS YOURS</span>
        </div>
        <div>
          <ChapterHeading
            number="05"
            eyebrow="LEAVE SOMETHING ON THE RECORD"
            id="history-title"
          >
            The season ends.
            <br />
            The stories stay.
          </ChapterHeading>
          <p className={styles.chapterIntro}>
            That unlikely playoff run. The game you still talk about. The roster
            you’d play with again. Season archives, recaps, the record book, and
            the Hall of Fame give those moments a home.
          </p>
          <div className={styles.chapterLinks}>
            <TourLink href="/seasons">Past seasons</TourLink>
            <TourLink href="/hall-of-fame">Hall of Fame</TourLink>
            <TourLink href="/records">The record book</TourLink>
          </div>
        </div>
        {numbers.length > 0 ? (
          <dl className={styles.leagueNumbers}>
            {numbers.map((number) => (
              <div key={number.label}>
                <dt>{number.label}</dt>
                <dd>{number.value.toLocaleString("en-US")}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </section>

      <section
        id="all-features"
        aria-labelledby="directory-title"
        className={styles.directorySection}
      >
        <p className={styles.eyebrow}>THE FULL DIRECTORY</p>
        <h2 id="directory-title" className={styles.chapterTitle}>
          Everything the league offers.
        </h2>
        <p className={styles.chapterIntro}>
          Looking for something specific? Start here. Features that need a live
          season or recorded results show when they become available.
        </p>
        <FeatureDirectory groups={groups} />
      </section>

      <section
        id="join"
        aria-labelledby="join-title"
        className={styles.joinSection}
      >
        <div>
          <p className={styles.eyebrow}>YOUR FIRST SEASON STARTS HERE</p>
          <h2 id="join-title" className={styles.chapterTitle}>
            Bring yourself.
            <br />
            We’ll start with that.
          </h2>
          <p className={styles.chapterIntro}>
            You don’t need to assemble a stack. Sign up as a player, tell
            captains a little about yourself, and be ready to commit to your
            team’s matches.
          </p>
          <ol className={styles.joinSteps}>
            <li>
              <span>01</span>
              <div>
                <h3>Sign in with Steam</h3>
                <p>Your Steam account is your league identity.</p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <h3>Complete your signup</h3>
                <p>
                  Choose player or standin, confirm your details, and add roles
                  and heroes to help captains get to know you.
                </p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <h3>Stay in the loop</h3>
                <p>
                  Check the season’s draft and match schedule. Join your
                  league’s Discord when available for team coordination and
                  announcements.
                </p>
              </div>
            </li>
          </ol>
        </div>
        <div className={styles.faq}>
          <h3>A few things before you join</h3>
          <details>
            <summary>Who is the league for?</summary>
            <p>
              An amateur Dota 2 community.{" "}
              {softLimit > 0 ? (
                <>
                  The current soft limit is {softLimit.toLocaleString("en-US")}{" "}
                  MMR; players above it can be reviewed before the draft.{" "}
                </>
              ) : (
                <>This season has no additional soft MMR limit. </>
              )}
              Players above {HARD_MMR_CEILING.toLocaleString("en-US")} MMR and
              Immortal players are not eligible.
            </p>
          </details>
          <details>
            <summary>Do I need to bring a team?</summary>
            <p>
              No. Players sign up individually, and captains build rosters in
              the auction draft. Add your preferred roles and favorite heroes so
              captains can see how you might fit.
            </p>
          </details>
          <details>
            <summary>Where and when do we play?</summary>
            <p>
              This is the {regionName} league, using{" "}
              {LEAGUE_CONFIG.gameServerRegion} servers.{" "}
              {LEAGUE_CONFIG.matchSchedule.announced ? (
                <>
                  The usual match night is {LEAGUE_CONFIG.matchSchedule.label}
                  .{" "}
                </>
              ) : (
                <>The regular match night has not been announced yet. </>
              )}
              Check the season schedule for each fixture’s confirmed kickoff,
              shown in your local time.
            </p>
          </details>
          <details>
            <summary>What if I cannot commit to every week?</summary>
            <p>
              Consider signing up as a standin to cover roster absences, or play
              inhouses without a season-long team commitment. Let organizers and
              captains know what you can manage before joining a roster.
            </p>
          </details>
          <details>
            <summary>How do my games get recorded?</summary>
            <p>
              The site imports eligible Dota matches through OpenDota. Enable
              Expose Public Match Data in Dota and follow the match’s lobby
              instructions. Imports can take time; match IDs and manual result
              reporting provide fallback paths.
            </p>
          </details>
          <details>
            <summary>Can I follow along without playing?</summary>
            <p>
              Yes. Browse teams, results, profiles, and league history. A Steam
              login also lets you take part in fantasy and pick’em when they are
              open; you do not need a roster spot.
            </p>
          </details>
        </div>
      </section>

      <section aria-labelledby="tour-closing-title" className={styles.closing}>
        <div>
          <p className={styles.eyebrow}>
            {LEAGUE_CONFIG.name} · {regionName}
          </p>
          <h2 id="tour-closing-title">{closing.title}</h2>
          <p>
            {!closing.action && !LEAGUE_CONFIG.discordInviteUrl
              ? "Check league news for the next signup announcement. Inhouses are another way to meet the community in the meantime."
              : closing.detail}
          </p>
        </div>
        <div className={styles.closingActions}>
          {closing.action ? (
            <Link
              href={closing.action.href}
              className={buttonClasses("accent", "lg", styles.primaryAction)}
            >
              {closing.action.label}
            </Link>
          ) : null}
          <DiscordButton size="lg" label="Meet the community" />
          {!LEAGUE_CONFIG.discordInviteUrl ? (
            <Link href="/news" className={buttonClasses("secondary", "lg")}>
              League news <span aria-hidden="true">→</span>
            </Link>
          ) : null}
        </div>
      </section>
      <div className={styles.communityLinks}>
        <p>Keep up with the league. Take a little of it with you.</p>
        <div>
          <Link href="/news">
            League news <span aria-hidden="true">↗</span>
          </Link>
          <a
            href={LEAGUE_CONFIG.merchUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            League shop <span className="sr-only">(opens in a new tab)</span>
            <span aria-hidden="true">↗</span>
          </a>
        </div>
      </div>
    </div>
  );
}
