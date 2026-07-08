import Link from "next/link";
import { Badge, DiscordButton } from "@/components/ui";

const PHASE_LABEL: Record<string, string> = {
  SIGNUPS: "Signups open",
  DRAFT: "Draft in progress",
  REGULAR_SEASON: "Regular season",
  PLAYOFFS: "Playoffs",
  COMPLETE: "Season complete",
};

const PHASE_TONE: Record<
  string,
  "brand" | "accent" | "success" | "info" | "neutral"
> = {
  SIGNUPS: "info",
  DRAFT: "accent",
  REGULAR_SEASON: "success",
  PLAYOFFS: "accent",
  COMPLETE: "brand",
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
    { href: "/inhouse", label: "Inhouse" },
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
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-brand to-brand/60 text-[10px] font-bold tracking-tight text-brand-fg ring-1 ring-white/15">
                4.5K
              </span>
              <span className="font-display text-base font-semibold uppercase tracking-wide">
                Under 4.5K League
              </span>
            </div>
            <p className="mt-2 text-sm text-muted">
              A drafted, team-based Dota 2 league for players under 4500 MMR.
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
          <span>© {year} Under 4.5K League</span>
          {seasonName ? (
            <span className="flex items-center gap-2">
              <span>{seasonName}</span>
              {phase ? (
                <Badge tone={PHASE_TONE[phase] ?? "neutral"}>
                  {PHASE_LABEL[phase] ?? phase}
                </Badge>
              ) : null}
            </span>
          ) : null}
        </div>
      </div>
    </footer>
  );
}
