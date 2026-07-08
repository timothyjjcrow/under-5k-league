"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
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
    // Inhouse is a standalone pick-up mode — always available, season or not.
    { href: "/inhouse", label: "Inhouse" },
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
  const myTeamHref = myTeamId ? `/teams/${myTeamId}` : null;
  const [open, setOpen] = useState(false);

  // Close the mobile menu whenever the route changes (e.g. a link was tapped).
  useEffect(() => setOpen(false), [pathname]);

  const adminActive = pathname.startsWith("/admin");

  return (
    <header className="sticky top-0 z-30 border-b border-line/80 bg-bg/80 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Link
          href="/"
          aria-label="Under 5k League — home"
          className="flex shrink-0 items-center gap-2"
        >
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand font-bold text-brand-fg">
            5K
          </span>
          <span className="hidden font-display text-lg font-semibold uppercase tracking-wide sm:block">
            Under 5k League
          </span>
        </Link>

        {/* Inline nav — only when there's room (lg+). Below that it collapses
            into the menu button so links never get cut off. */}
        <nav
          aria-label="Primary"
          className="hidden min-w-0 flex-1 items-center gap-1 lg:flex"
        >
          {items.map((item) => {
            const active = isActive(pathname, item.href, myTeamHref);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
                  active
                    ? "bg-accent/15 text-fg"
                    : "text-muted hover:bg-surface-2/60 hover:text-fg",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Pushes the account cluster to the right when the inline nav is hidden. */}
        <div className="flex-1 lg:hidden" />

        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          {/* Season phase/name lives on the home hero + footer, not here — it
              kept the nav from fitting once the league adds its links. */}
          {user ? (
            <>
              {user.role === "ADMIN" ? (
                <Link
                  href="/admin"
                  className={cn(
                    "hidden rounded-lg px-3 py-2 text-sm font-medium transition-colors lg:block",
                    adminActive
                      ? "bg-surface-2 text-accent"
                      : "text-accent/80 hover:text-accent",
                  )}
                >
                  Admin
                </Link>
              ) : null}
              <Link
                href="/me"
                className="flex items-center gap-2 rounded-full border border-line py-1 pl-1 pr-1 text-sm hover:border-muted/60 xl:pr-3"
              >
                <Avatar name={user.name} src={user.avatar} size={28} />
                <span className="hidden max-w-[8rem] truncate xl:block">
                  {user.name}
                </span>
              </Link>
              <a
                href="/api/auth/logout"
                className="hidden text-sm text-muted hover:text-fg lg:inline"
                title="Log out"
              >
                Logout
              </a>
            </>
          ) : (
            <Link
              href="/login"
              className="rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg hover:bg-brand/90 sm:px-4"
            >
              Sign in
            </Link>
          )}

          {/* Menu toggle — only below lg, where the inline nav is hidden. */}
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="mobile-nav"
            className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-surface-2/60 hover:text-fg lg:hidden"
          >
            {open ? <CloseIcon /> : <MenuIcon />}
          </button>
        </div>
      </div>

      {/* Mobile dropdown: holds every nav link + account actions so nothing is
          ever clipped. Overlays content (absolute) to avoid a layout jump. */}
      {open ? (
        <nav
          id="mobile-nav"
          aria-label="Primary"
          className="absolute inset-x-0 top-full border-b border-line/80 bg-bg/95 shadow-lg backdrop-blur lg:hidden"
        >
          <div className="mx-auto max-w-6xl space-y-1 px-4 py-3 sm:px-6">
            {items.map((item) => {
              const active = isActive(pathname, item.href, myTeamHref);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "block rounded-lg px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
                    active
                      ? "bg-accent/15 text-fg"
                      : "text-muted hover:bg-surface-2/60 hover:text-fg",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}

            {(user?.role === "ADMIN" || user || seasonName) && (
              <div className="mt-1 space-y-1 border-t border-line/80 pt-2">
                {user?.role === "ADMIN" ? (
                  <Link
                    href="/admin"
                    aria-current={adminActive ? "page" : undefined}
                    className={cn(
                      "block rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                      adminActive
                        ? "bg-surface-2 text-accent"
                        : "text-accent/80 hover:bg-surface-2/60 hover:text-accent",
                    )}
                  >
                    Admin
                  </Link>
                ) : null}
                {user ? (
                  <a
                    href="/api/auth/logout"
                    className="block rounded-lg px-3 py-2.5 text-sm font-medium text-muted hover:bg-surface-2/60 hover:text-fg"
                  >
                    Log out
                  </a>
                ) : null}
                {seasonName ? (
                  <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted">
                    {phase ? (
                      <Badge tone={PHASE_TONE[phase] ?? "neutral"}>
                        {PHASE_LABEL[phase] ?? phase}
                      </Badge>
                    ) : null}
                    <span>{seasonName}</span>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </nav>
      ) : null}
    </header>
  );
}

function MenuIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}
