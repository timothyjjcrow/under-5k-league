"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Avatar, Badge } from "@/components/ui";
import { cn } from "@/lib/utils";

const PHASE_LABEL: Record<string, string> = {
  SIGNUPS: "Signups",
  DRAFT: "Draft",
  REGULAR_SEASON: "Regular season",
  PLAYOFFS: "Playoffs",
  COMPLETE: "Complete",
};

const PHASE_TONE: Record<string, "brand" | "accent" | "success" | "info"> = {
  SIGNUPS: "info",
  DRAFT: "accent",
  REGULAR_SEASON: "success",
  PLAYOFFS: "accent",
  COMPLETE: "brand",
};

type HeaderUser = {
  name: string;
  avatar: string | null;
  role: string;
} | null;

// Which nav links are visible depends on the season phase — this is the core of
// "hide what isn't relevant right now".
function navItems(phase: string | null, myTeamId: string | null) {
  const items: { href: string; label: string }[] = [
    { href: "/", label: "Home" },
    { href: "/players", label: "Players" },
  ];
  const teamsExist =
    phase === "DRAFT" ||
    phase === "REGULAR_SEASON" ||
    phase === "PLAYOFFS" ||
    phase === "COMPLETE";
  if (teamsExist) items.push({ href: "/teams", label: "Teams" });
  if (myTeamId) items.push({ href: `/teams/${myTeamId}`, label: "My Team" });
  if (phase === "DRAFT") items.push({ href: "/draft", label: "Draft" });
  if (phase === "REGULAR_SEASON" || phase === "PLAYOFFS" || phase === "COMPLETE") {
    items.push({ href: "/schedule", label: "Schedule" });
    items.push({ href: "/leaders", label: "Leaders" });
  }
  return items;
}

// Highlight the current section. "/teams" (index) and "My Team" (/teams/<id>)
// overlap, so the more specific "My Team" wins on that exact page.
function isActive(
  pathname: string,
  href: string,
  myTeamHref: string | null,
): boolean {
  if (href === "/") return pathname === "/";
  const onPath = pathname === href || pathname.startsWith(href + "/");
  if (!onPath) return false;
  if (
    href === "/teams" &&
    myTeamHref &&
    (pathname === myTeamHref || pathname.startsWith(myTeamHref + "/"))
  ) {
    return false;
  }
  return true;
}

export function SiteHeader({
  user,
  phase,
  seasonName,
  myTeamId,
}: {
  user: HeaderUser;
  phase: string | null;
  seasonName: string | null;
  myTeamId: string | null;
}) {
  const pathname = usePathname();
  const items = navItems(phase, myTeamId);

  return (
    <header className="sticky top-0 z-30 border-b border-line/80 bg-bg/80 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand font-bold text-brand-fg">
            5K
          </span>
          <span className="hidden text-lg font-semibold tracking-tight sm:block">
            Under 5k League
          </span>
        </Link>

        <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {items.map((item) => {
            const active = isActive(pathname, item.href, myTeamId ? `/teams/${myTeamId}` : null);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-surface-2 text-fg"
                    : "text-muted hover:bg-surface-2/60 hover:text-fg",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-3 pl-2">
          {seasonName ? (
            <div className="hidden items-center gap-2 md:flex">
              {phase ? (
                <Badge tone={PHASE_TONE[phase] ?? "neutral"}>
                  {PHASE_LABEL[phase] ?? phase}
                </Badge>
              ) : null}
              <span className="text-sm text-muted">{seasonName}</span>
            </div>
          ) : null}

          {user ? (
            <div className="flex items-center gap-2">
              {user.role === "ADMIN" ? (
                <Link
                  href="/admin"
                  className={cn(
                    "rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                    pathname.startsWith("/admin")
                      ? "bg-surface-2 text-accent"
                      : "text-accent/80 hover:text-accent",
                  )}
                >
                  Admin
                </Link>
              ) : null}
              <Link
                href="/me"
                className="flex items-center gap-2 rounded-full border border-line py-1 pl-1 pr-3 text-sm hover:border-muted/60"
              >
                <Avatar name={user.name} src={user.avatar} size={28} />
                <span className="max-w-[8rem] truncate">{user.name}</span>
              </Link>
              <a
                href="/api/auth/logout"
                className="text-sm text-muted hover:text-fg"
                title="Log out"
              >
                Logout
              </a>
            </div>
          ) : (
            <Link
              href="/login"
              className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-fg hover:bg-brand/90"
            >
              Sign in
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
