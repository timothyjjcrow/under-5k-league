import Link from "next/link";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  HeroIcon,
  HeroList,
  HeroPool,
  SectionTitle,
  textLink,
} from "@/components/ui";
import { heroById } from "@/lib/heroes";
import type { PubHero } from "@/lib/pub-stats";
import {
  recordWatchText,
  type PlayerRecord,
  type RecordWatchLine,
} from "@/lib/records";
import type { HeroPoolRow } from "@/lib/scouting";
import { formatNetWorth, hasText } from "@/lib/utils";

/** Games on a hero before its win rate gets a colour; below it, a plain W–L. */
const HERO_RATE_MIN_GAMES = 3;

/**
 * The "Player profile" band: the heroes they play (league games, public pubs
 * and their own favorites), any all-time league record they hold and the one
 * within reach. The page renders the band only when at least one of its
 * cards shows.
 */
export function ProfileHeroesAndRecords({
  showHeroes,
  showRecords,
  leagueHeroes,
  selfPickedHeroes,
  pubHeroes,
  pubCheckedLabel,
  heldRecords,
  recordWatch = null,
}: {
  showHeroes: boolean;
  showRecords: boolean;
  leagueHeroes: HeroPoolRow[];
  /** The favorite heroes on their active signup. */
  selfPickedHeroes: string | undefined;
  /** OpenDota's most-played, from their stored pub snapshot. */
  pubHeroes: PubHero[];
  /** How long ago that snapshot was taken ("3d ago"). */
  pubCheckedLabel: string | null;
  heldRecords: PlayerRecord[];
  /** The league record they are closest to (`recordWatchFor`), if any. */
  recordWatch?: RecordWatchLine | null;
}) {
  return (
    <section id="player-about" className="scroll-mt-40 space-y-3">
      <SectionTitle>Player profile</SectionTitle>
      <div className="space-y-5">
        {showHeroes ? (
          <Card id="player-heroes" className="min-w-0 scroll-mt-40">
            <CardHeader
              title="Hero pool"
              subtitle="League games, public pubs, and their favorite heroes"
            />
            <CardBody className="space-y-4">
              {leagueHeroes.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted">
                    In this league
                  </div>
                  <HeroPool
                    heroes={leagueHeroes}
                    minGamesForRate={HERO_RATE_MIN_GAMES}
                    columns="container"
                  />
                </div>
              ) : null}
              {hasText(selfPickedHeroes) ? (
                <div className="space-y-2">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted">
                    Favorite heroes
                  </div>
                  <HeroList value={selfPickedHeroes} size={26} />
                </div>
              ) : null}
              {pubHeroes.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted">
                    Most played (pubs)
                    {pubCheckedLabel ? (
                      <span className="font-normal normal-case tracking-normal">
                        {" "}
                        · checked {pubCheckedLabel}
                      </span>
                    ) : null}
                  </div>
                  <HeroPool
                    heroes={pubHeroes}
                    limit={5}
                    minGamesForRate={HERO_RATE_MIN_GAMES}
                    columns="container"
                  />
                </div>
              ) : null}
            </CardBody>
          </Card>
        ) : null}

        {showRecords ? (
          <Card id="player-records" className="min-w-0 scroll-mt-40">
            <CardHeader
              title="League records"
              subtitle="All-time single-game records"
              action={
                <Link href="/records" className={textLink("text-sm")}>
                  Record book →
                </Link>
              }
            />
            <CardBody className="flex flex-wrap gap-2">
              {heldRecords.map((record) => {
                const hero = heroById(record.heroId);
                return (
                  <Link
                    key={record.key}
                    href={`/matches/${record.matchId}`}
                    className="flex items-center gap-2 rounded-lg border border-line bg-surface-2/40 px-3 py-2 text-sm transition-colors hover:border-muted/60"
                    title={`${record.title}: ${recordDisplayValue(record)}`}
                  >
                    <span aria-hidden>{record.emoji}</span>
                    {hero ? <HeroIcon hero={hero} size={22} /> : null}
                    <span>
                      <span className="block font-medium">{record.title}</span>
                      <span className="block font-mono text-xs tabular-nums text-muted">
                        {recordDisplayValue(record)}
                      </span>
                    </span>
                    <Badge tone={record.won ? "success" : "danger"}>
                      {record.won ? "W" : "L"}
                    </Badge>
                  </Link>
                );
              })}
              {recordWatch ? <WithinReach line={recordWatch} /> : null}
            </CardBody>
          </Card>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The league record this player is closest to breaking, on a row of its own
 * under the chips (`w-full` in the card's wrapping row): stored marks only,
 * "Career best 18 kills · record 21, 3 short", never a pace.
 */
function WithinReach({ line }: { line: RecordWatchLine }) {
  return (
    <div className="w-full min-w-0 rounded-lg border border-dashed border-line px-3 py-2 text-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">
        Within reach
      </p>
      <p className="mt-0.5 [overflow-wrap:anywhere]">
        <span aria-hidden>{line.emoji} </span>
        <span className="font-medium">{line.title}</span>
        <span className="text-muted">{` · ${recordWatchText(line)}`}</span>
      </p>
    </div>
  );
}

function recordDisplayValue(record: PlayerRecord): string {
  switch (record.key) {
    case "netWorth":
      return formatNetWorth(record.value);
    case "gpm":
      return `${record.value} GPM`;
    case "xpm":
      return `${record.value} XPM`;
    default:
      return new Intl.NumberFormat("en-US").format(record.value);
  }
}
