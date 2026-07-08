import Link from "next/link";
import { DiscordButton } from "@/components/ui";

const PHASE_LABEL: Record<string, string> = {
  SIGNUPS: "Signups open",
  DRAFT: "Draft in progress",
  REGULAR_SEASON: "Regular season",
  PLAYOFFS: "Playoffs",
  COMPLETE: "Season complete",
};

export function SiteFooter({
  seasonName,
  phase,
}: {
  seasonName: string | null;
  phase: string | null;
}) {
  const year = new Date().getFullYear();
  const links: { href: string; label: string }[] = [
    { href: "/", label: "Home" },
    { href: "/players", label: "Players" },
  ];
  if (phase === "DRAFT") links.push({ href: "/draft", label: "Draft" });
  if (
    phase === "REGULAR_SEASON" ||
    phase === "PLAYOFFS" ||
    phase === "COMPLETE"
  ) {
    links.push({ href: "/schedule", label: "Schedule" });
  }

  return (
    <footer className="border-t border-line/70">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-sm">
            <div className="flex items-center gap-2">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand text-sm font-bold text-brand-fg">
                5K
              </span>
              <span className="font-semibold tracking-tight">
                Under 5k League
              </span>
            </div>
            <p className="mt-2 text-sm text-muted">
              A drafted, team-based Dota 2 league for players under 5000 MMR.
            </p>
            <DiscordButton size="sm" className="mt-4" />
          </div>
          <nav className="flex flex-col gap-2 text-sm">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              Explore
            </span>
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="text-muted transition-colors hover:text-fg"
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line/60 pt-4 text-xs text-muted">
          <span>© {year} Under 5k League</span>
          {seasonName ? (
            <span>
              {seasonName}
              {phase ? ` · ${PHASE_LABEL[phase] ?? phase}` : ""}
            </span>
          ) : null}
        </div>
      </div>
    </footer>
  );
}
