import {
  Card,
  CardBody,
  CardHeader,
  FormStrip,
  HeroPool,
  KDA,
  RankMedal,
} from "@/components/ui";
import {
  pubHeroRows,
  pubLobbyRead,
  scoutingFacts,
  type PubRoleAverages,
  type PubScout,
  type ScoutContext,
  type ScoutFact,
  type ScoutTone,
} from "@/lib/pub-scout";
import type { FormResult } from "@/lib/team-matches";
import { cn } from "@/lib/utils";

/** Games on a hero before its win rate gets a colour; below it, a plain W–L. */
const HERO_RATE_MIN_GAMES = 3;
/** Games in a role before its averages are worth a line. */
const ROLE_LINE_MIN_GAMES = 5;

const TONE_MARK: Record<
  ScoutTone,
  { glyph: string; spoken: string; className: string }
> = {
  good: {
    glyph: "✓",
    spoken: "Agrees with their signup:",
    className: "text-success",
  },
  warn: {
    glyph: "!",
    spoken: "Worth a second look:",
    className: "text-accent",
  },
  info: { glyph: "•", spoken: "", className: "text-muted" },
};

/**
 * The pub scouting report captains read before bidding: what a signup's last
 * 100 public games say about their role and lanes, the level of their games
 * set against their signup MMR and medal, their modes, queue, server, form
 * and activity, then their recent heroes and how they play as a core or a
 * support. Every line comes from the stored snapshot's counts
 * (pub-scout.ts) and shows only with enough games behind it; the page
 * renders the card only when one does.
 */
export function ProfilePubScouting({
  scout,
  context,
  checkedLabel,
}: {
  scout: PubScout;
  context: ScoutContext;
  /** How long ago the snapshot was taken ("3d ago"). */
  checkedLabel: string | null;
}) {
  const facts = scoutingFacts(scout, context);
  const lobby = pubLobbyRead(scout);
  const heroes = pubHeroRows(scout);
  const form = scout.form.split("") as FormResult[];
  const roleLines = [
    { label: "As a core", averages: scout.coreAverages },
    { label: "As a support", averages: scout.supportAverages },
  ].filter(
    (r): r is { label: string; averages: PubRoleAverages } =>
      r.averages != null && r.averages.games >= ROLE_LINE_MIN_GAMES,
  );
  return (
    <Card id="player-scouting" className="min-w-0 scroll-mt-40">
      <CardHeader
        title="Pub scouting report"
        subtitle={`Their last ${scout.games} public games on OpenDota${
          checkedLabel ? ` · checked ${checkedLabel}` : ""
        }`}
      />
      <CardBody className="space-y-5">
        {facts.length > 0 ? (
          <dl className="divide-y divide-line-soft">
            {facts.map((fact) => (
              <FactRow
                key={fact.key}
                fact={fact}
                extra={
                  fact.key === "level" && lobby ? (
                    <RankMedal rankTier={lobby.rankTier} size={22} />
                  ) : null
                }
                after={
                  fact.key === "form" && form.length > 0 ? (
                    <FormStrip form={form} size={5} className="mt-1" />
                  ) : null
                }
              />
            ))}
          </dl>
        ) : null}

        {heroes.length > 0 ? (
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted">
              Recent heroes
              <span className="font-normal normal-case tracking-normal">
                {" "}
                · {scout.heroCount} different in these games
              </span>
            </div>
            <HeroPool
              heroes={heroes}
              limit={6}
              minGamesForRate={HERO_RATE_MIN_GAMES}
              columns="container"
            />
          </div>
        ) : null}

        {roleLines.length > 0 ? (
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted">
              How they play
            </div>
            <ul className="space-y-1.5 text-sm">
              {roleLines.map(({ label, averages }) => (
                <li key={label} className="min-w-0">
                  <span className="font-medium text-fg">{label}</span>
                  <span className="text-muted">
                    {" "}
                    ({averages.games} games):{" "}
                  </span>
                  <span className="whitespace-nowrap tabular-nums">
                    {averages.lastHitsPerMin} last hits a minute
                  </span>
                  <span className="text-muted"> · </span>
                  <span className="whitespace-nowrap tabular-nums">
                    {averages.gpm} GPM
                  </span>
                  <span className="text-muted"> · </span>
                  <span className="whitespace-nowrap">
                    <KDA
                      kills={averages.kills}
                      deaths={averages.deaths}
                      assists={averages.assists}
                    />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="text-xs leading-relaxed text-muted">
          A game counts as core at 3.5+ last hits a minute and support under
          2.5, in ranked and unranked games of 10+ minutes. Lanes come from the
          games OpenDota analysed. &ldquo;Plays at&rdquo; is the average medal
          of the players in their games.
        </p>
      </CardBody>
    </Card>
  );
}

function FactRow({
  fact,
  extra,
  after,
}: {
  fact: ScoutFact;
  extra: React.ReactNode;
  after: React.ReactNode;
}) {
  const mark = TONE_MARK[fact.tone];
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 py-2.5 first:pt-0 last:pb-0 @md:grid-cols-[6.5rem_minmax(0,1fr)]">
      <dt className="flex items-center gap-1.5 text-xs font-medium text-muted @md:pt-0.5">
        <span
          aria-hidden
          className={cn("w-3 text-center font-bold", mark.className)}
        >
          {mark.glyph}
        </span>
        {mark.spoken ? <span className="sr-only">{mark.spoken}</span> : null}
        {fact.label}
      </dt>
      <dd className="min-w-0">
        <div
          className={cn(
            "flex items-center gap-2 text-sm font-semibold",
            fact.tone === "warn" ? "text-accent" : "text-fg",
          )}
        >
          {extra}
          <span className="min-w-0 [overflow-wrap:anywhere]">{fact.lead}</span>
        </div>
        {fact.detail ? (
          <div className="text-xs text-muted [overflow-wrap:anywhere]">
            {fact.detail}
          </div>
        ) : null}
        {after}
      </dd>
    </div>
  );
}
