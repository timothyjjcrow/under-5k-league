import Link from "next/link";
import { Suspense } from "react";
import { DiscordButton, LinkArrow, buttonClasses } from "@/components/ui";
import type { SessionUser } from "@/lib/auth";
import { announcedMatchNight } from "@/lib/match-night";
import type { DefendingChampion } from "@/lib/official-champion";
import { HISTORY_PHASE_LABEL } from "@/lib/season-copy";
import {
  DefendingChampionLine,
  Hero,
  LeaguePitch,
  PHASE_STEP,
} from "./hero";
import { InhouseStrip } from "./inhouse-strip";
import { LeagueNews, PinnedNotices } from "./news";

/**
 * Home with no active season: what the last season left, the inhouse queue
 * (the only live play surface until the next season) and the news, where the
 * next season gets announced.
 */
export function OffseasonView({
  user,
  latestSeason,
  defending,
}: {
  user: SessionUser | null;
  /** The newest archived season, if any. */
  latestSeason: { id: string; name: string; status: string } | null;
  defending: DefendingChampion | null;
}) {
  return (
    <div className="mx-auto max-w-2xl py-10">
      <Hero
        phase={null}
        title="League offseason"
        subtitle={
          latestSeason
            ? latestSeason.status === "COMPLETE"
              ? `${latestSeason.name} has wrapped up. Browse the completed season or play an inhouse while the next league is organized.`
              : `${latestSeason.name} was archived before completion during the ${PHASE_STEP[latestSeason.status] ?? HISTORY_PHASE_LABEL[latestSeason.status] ?? latestSeason.status} phase. Browse its saved state or play an inhouse while administrators organize what comes next.`
            : "There isn't an active season yet. Explore how the league works or play an inhouse while the first season is organized."
        }
        pitch={
          user ? undefined : (
            <LeaguePitch matchNight={announcedMatchNight(null, [])} />
          )
        }
      />
      {defending ? (
        <DefendingChampionLine
          champion={defending}
          className="mt-4 justify-center"
        />
      ) : null}
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Link href="/inhouse" className={buttonClasses("accent")}>
          Play an inhouse <LinkArrow />
        </Link>
        {latestSeason ? (
          <Link
            href={`/seasons/${latestSeason.id}`}
            className={buttonClasses("secondary")}
          >
            Review {latestSeason.name} <LinkArrow />
          </Link>
        ) : (
          <Link href="/how-it-works" className={buttonClasses("secondary")}>
            How it works
          </Link>
        )}
        <DiscordButton />
        {user?.role === "ADMIN" ? (
          <Link href="/admin" className={buttonClasses("secondary")}>
            Create a season
          </Link>
        ) : null}
      </div>
      {/* News has no season, and between seasons is when the next one gets
          announced: the pinned strip and the latest posts show here too. */}
      <Suspense fallback={null}>
        <PinnedNotices className="mt-5" />
      </Suspense>
      {/* Inhouse is the only live play surface during the offseason. Keep its
          actual queue/lobby state visible here too, rather than replacing a
          useful "4/10 queued" signal with a generic hero button. */}
      <Suspense
        fallback={
          <div className="mt-5 skeleton h-12 rounded-[var(--radius)]" />
        }
      >
        <div className="mt-5">
          <InhouseStrip />
        </div>
      </Suspense>
      <Suspense fallback={null}>
        <LeagueNews className="mt-6" />
      </Suspense>
    </div>
  );
}
