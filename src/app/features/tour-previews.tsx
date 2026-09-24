import type { ReactNode } from "react";
import { HeroIcon, TeamCrest } from "@/components/ui";
import { heroById } from "@/lib/heroes";
import styles from "./features.module.css";

function Preview({
  title,
  children,
  className = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure className={`${styles.preview} ${className}`}>
      <figcaption className={styles.previewBar}>
        <span>{title}</span>
        <span className={styles.exampleLabel}>Illustrative preview</span>
      </figcaption>
      {children}
    </figure>
  );
}

function Heroes({ ids }: { ids: number[] }) {
  return (
    <div className={styles.heroIcons}>
      {ids.map((id) => {
        const hero = heroById(id);
        return hero ? <HeroIcon key={id} hero={hero} size={30} /> : null;
      })}
    </div>
  );
}

export function MatchPreview() {
  return (
    <Preview title="The match center" className={styles.heroPreview}>
      <div className={styles.matchTopline}>
        <span>WEEK 04 · REGULAR SEASON</span>
        <span className={styles.completePill}>Series complete</span>
      </div>
      <div className={styles.matchScore}>
        <div>
          <TeamCrest name="River Wardens" seed="river" size={46} />
          <strong>River Wardens</strong>
          <span>Radiant</span>
        </div>
        <p>
          <b>2</b>
          <span>–</span>
          <b>0</b>
        </p>
        <div>
          <TeamCrest name="Night Shift" seed="night" size={46} />
          <strong>Night Shift</strong>
          <span>Dire</span>
        </div>
      </div>
      <div className={styles.matchLineups}>
        <Heroes ids={[8, 74, 2, 26, 5]} />
        <span>GAME 2</span>
        <Heroes ids={[1, 13, 29, 86, 30]} />
      </div>
      <div className={styles.matchMvp}>
        <div className={styles.mvpMonogram} aria-hidden="true">
          MVP
        </div>
        <div>
          <span>GAME 2 · JUGGERNAUT</span>
          <strong>One more for the highlight reel.</strong>
        </div>
        <p>
          <b>11 / 2 / 9</b>
          <span>K / D / A</span>
        </p>
      </div>
      <div className={styles.matchFooter}>
        <span>Box scores</span>
        <span>Hero report cards</span>
        <span>Standings updated</span>
      </div>
    </Preview>
  );
}

export function DraftPreview() {
  const hero = heroById(5);
  return (
    <Preview title="Auction night">
      <div className={styles.draftNomination}>
        <div className={styles.previewEyebrow}>ON THE BLOCK</div>
        <div className={styles.draftPlayer}>
          {hero ? <HeroIcon hero={hero} size={54} /> : null}
          <div>
            <strong>Your next teammate</strong>
            <span>Position 5 · 2,800 MMR</span>
          </div>
        </div>
        <p>“Support main. Happy to captain the warding effort.”</p>
      </div>
      <dl className={styles.auctionNumbers}>
        <div>
          <dt>Leading bid</dt>
          <dd>$240</dd>
        </div>
        <div>
          <dt>Time remaining</dt>
          <dd>00:18</dd>
        </div>
      </dl>
      <div className={styles.bidTrack} aria-hidden="true">
        <span />
      </div>
      <div className={styles.draftBids}>
        <div>
          <span>River Wardens</span>
          <strong>$240</strong>
          <span>Leading</span>
        </div>
        <div>
          <span>Night Shift</span>
          <strong>$220</strong>
          <span>Previous bid</span>
        </div>
      </div>
      <p className={styles.previewNote}>
        Every bid changes the roster you could be playing with.
      </p>
    </Preview>
  );
}

export function ReportPreview() {
  const hero = heroById(8);
  const metrics = [
    { label: "Gold per minute", value: 94, grade: "S" },
    { label: "Experience per minute", value: 82, grade: "A" },
    { label: "Kills per minute", value: 68, grade: "B" },
    { label: "Hero damage per minute", value: 57, grade: "B" },
  ];
  return (
    <Preview title="A closer look at your game">
      <div className={styles.reportHeader}>
        {hero ? <HeroIcon hero={hero} size={48} /> : null}
        <div>
          <strong>Juggernaut</strong>
          <span>Performance against same-hero benchmarks</span>
        </div>
        <div className={styles.reportGrade}>
          <b>A</b>
          <span>OVERALL</span>
        </div>
      </div>
      <dl className={styles.reportMetrics}>
        {metrics.map((metric) => (
          <div key={metric.label}>
            <dt>{metric.label}</dt>
            <dd>
              <span>{metric.value}th percentile</span>
              <b>{metric.grade}</b>
            </dd>
            <div className={styles.metricBar} aria-hidden="true">
              <span style={{ width: `${metric.value}%` }} />
            </div>
          </div>
        ))}
      </dl>
      <p className={styles.reportInsight}>
        <span>THE NEXT THING TO WORK ON</span>Your farming is ahead of your
        fighting. Look at how much of that gold becomes damage.
      </p>
      <p className={styles.previewNote}>
        Example interpretation. Actual grades depend on available OpenDota
        benchmarks.
      </p>
    </Preview>
  );
}

export function RacePreview() {
  return (
    <Preview title="The playoff picture">
      <div className={styles.raceHeader}>
        <span>THE LAST WEEK</span>
        <strong>Every result has a consequence.</strong>
      </div>
      <div className={styles.racePaths}>
        <div>
          <span>WIN</span>
          <strong>Through to playoffs</strong>
          <p>A direct qualification path.</p>
        </div>
        <div>
          <span>DRAW</span>
          <strong>One more match</strong>
          <p>A qualification tiebreaker.</p>
        </div>
        <div>
          <span>LOSS</span>
          <strong>Season on the line</strong>
          <p>Other results decide your fate.</p>
        </div>
      </div>
      <p className={styles.previewNote}>
        Illustrative paths. The live scenario engine uses the actual fixtures
        and standings rules, not predictive odds.
      </p>
    </Preview>
  );
}
