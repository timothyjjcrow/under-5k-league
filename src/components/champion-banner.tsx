import Link from "next/link";
import { TeamCrest } from "./ui";

/**
 * The amber champion banner (crest + trophy bubble + "{season} Champion"),
 * shared by /schedule and /seasons/[id] so a copy edit reaches both.
 * Server-safe; markup must stay byte-identical between the two surfaces.
 */
export function ChampionBanner({
  teamId,
  teamName,
  teamLogoUrl,
  seasonName,
}: {
  teamId: string;
  teamName: string;
  teamLogoUrl?: string | null;
  seasonName: string;
}) {
  return (
    <Link
      href={`/teams/${teamId}`}
      className="flex items-center gap-3 rounded-[var(--radius)] border border-amber-400/40 bg-amber-400/10 px-5 py-4 transition-colors hover:border-amber-400/60"
    >
      <div className="relative shrink-0">
        <TeamCrest
          name={teamName}
          seed={teamId}
          logoUrl={teamLogoUrl}
          size={44}
          className="rounded-xl ring-2 ring-amber-400/50"
        />
        <span
          aria-hidden
          className="absolute -bottom-1.5 -right-1.5 grid h-6 w-6 place-items-center rounded-full border border-amber-400/40 bg-surface text-xs shadow"
        >
          🏆
        </span>
      </div>
      <div>
        <div className="text-xs uppercase tracking-wide text-amber-300/90">
          {seasonName} Champion
        </div>
        <div className="text-lg font-bold">{teamName}</div>
      </div>
    </Link>
  );
}
