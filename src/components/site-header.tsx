"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Avatar, Badge } from "@/components/ui";
import { scheduleDestinationLabel } from "@/lib/season-copy";
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

type NavItem = { href: string; label: string };

// Which nav links are visible depends on the season phase — this is the core of
// "hide what isn't relevant right now".
function navItems(
  phase: string | null,
  myTeamId: string | null,
  hasHistory: boolean,
) {
  const items: NavItem[] = [
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
  // The feature tour matters most before the season unlocks everything —
  // once mid-season links crowd in, it lives in the footer instead.
  if (!teamsExist || phase === "DRAFT") {
    items.push({ href: "/features", label: "Features" });
  }
  if (teamsExist) {
    items.push({ href: "/teams", label: "Teams" });
  }
  if (myTeamId) items.push({ href: `/teams/${myTeamId}`, label: "My Team" });
  if (phase === "DRAFT") {
    items.push({ href: "/draft", label: "Draft" });
    // A completed auction can publish fixtures before the admin advances the
    // phase. The page itself explains the locked/in-progress state earlier in
    // DRAFT, so hiding this link only made a valid published schedule a secret.
    items.push({ href: "/schedule", label: "Schedule" });
  }
  if (
    phase === "REGULAR_SEASON" ||
    phase === "PLAYOFFS" ||
    phase === "COMPLETE"
  ) {
    items.push({
      href: "/schedule",
      label: scheduleDestinationLabel(phase),
    });
  }
  // The recap is the season's headline once it wraps; in-season it's reachable
  // from the Leaders page ("awards so far") to keep the nav from crowding.
  if (phase === "COMPLETE") items.push({ href: "/recap", label: "Recap" });
  // Past seasons only exist once one has been archived.
  if (hasHistory) items.push({ href: "/seasons", label: "History" });
  return items;
}

// High-density stats and side games live under Explore so the primary bar
// stays readable at ordinary laptop widths. Their phase gates are unchanged:
// Fantasy/Pick'em open with the completed auction, while Leaders/Meta join
// once regular-season results can exist.
function phaseExploreItems(phase: string | null): NavItem[] {
  if (phase === "DRAFT") {
    return [
      { href: "/fantasy", label: "Fantasy" },
      { href: "/pickem", label: "Pick'em" },
    ];
  }
  if (
    phase === "REGULAR_SEASON" ||
    phase === "PLAYOFFS" ||
    phase === "COMPLETE"
  ) {
    return [
      { href: "/leaders", label: "Leaders" },
      { href: "/meta", label: "Meta" },
      { href: "/fantasy", label: "Fantasy" },
      { href: "/pickem", label: "Pick'em" },
    ];
  }
  return [];
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
  hasHistory = false,
}: {
  user: HeaderUser;
  phase: string | null;
  seasonName: string | null;
  myTeamId: string | null;
  hasHistory?: boolean;
}) {
  const pathname = usePathname();
  const items = navItems(phase, myTeamId, hasHistory);
  const myTeamHref = myTeamId ? `/teams/${myTeamId}` : null;
  const [open, setOpen] = useState(false);
  const [desktopExploreOpen, setDesktopExploreOpen] = useState(false);
  const [mobileExploreOpen, setMobileExploreOpen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<"menu" | "explore">("menu");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const exploreButtonRef = useRef<HTMLButtonElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const dockRef = useRef<HTMLElement>(null);
  const discoveryRef = useRef<HTMLElement>(null);
  const dockExploreRef = useRef<HTMLButtonElement>(null);

  // Close the mobile menu whenever the route changes (e.g. a link was tapped).
  // Adjusted DURING RENDER rather than in an effect: React's documented way to
  // reset state when an input changes, and it avoids the extra committed frame
  // where the menu is still open on the new route.
  const [menuPath, setMenuPath] = useState(pathname);
  if (menuPath !== pathname) {
    setMenuPath(pathname);
    setOpen(false);
    setDesktopExploreOpen(false);
    setMobileExploreOpen(false);
  }

  // While the mobile menu is open, Escape closes it (returning focus to the
  // toggle so keyboard users don't lose their place) and a tap/click outside
  // the header dismisses it — a route change already closes it otherwise.
  useEffect(() => {
    if (!open && !desktopExploreOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        const returnTo = open
          ? mobilePanel === "explore"
            ? dockExploreRef.current
            : buttonRef.current
          : exploreButtonRef.current;
        setOpen(false);
        setDesktopExploreOpen(false);
        setMobileExploreOpen(false);
        returnTo?.focus();
      }
    }
    function onPointerDown(e: PointerEvent) {
      if (
        headerRef.current &&
        !headerRef.current.contains(e.target as Node) &&
        !dockRef.current?.contains(e.target as Node) &&
        !discoveryRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
        setDesktopExploreOpen(false);
        setMobileExploreOpen(false);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, desktopExploreOpen, mobilePanel]);

  const adminActive = pathname.startsWith("/admin");

  const exploreItems: NavItem[] = [
    ...phaseExploreItems(phase),
    // Scrim archives stay useful between seasons, but this side mode belongs
    // with the other secondary league tools so the primary bar never scrolls.
    { href: "/scrims", label: "Scrims" },
    { href: "/news", label: "League news" },
    { href: "/features", label: "Feature tour" },
    { href: "/records", label: "Record book" },
    { href: "/players/compare", label: "Compare players" },
    { href: "/hall-of-fame", label: "Hall of Fame" },
    ...(hasHistory ? [{ href: "/seasons", label: "Past seasons" }] : []),
  ];
  // The mobile primary menu already carries phase-native links such as
  // Features and History. Filter those duplicates while keeping the same
  // Explore ownership for Leaders, Meta, Fantasy and Pick'em on every size.
  const primaryHrefs = new Set(items.map((item) => item.href));
  const mobileExploreItems = exploreItems.filter(
    (item) => !primaryHrefs.has(item.href),
  );
  const exploreActive = exploreItems.some((item) =>
    isActive(pathname, item.href, myTeamHref),
  );
  const hasTeams = items.some((item) => item.href === "/teams");
  const dockItems = [
    { href: "/", label: "Home", icon: "home" as const },
    phase === "DRAFT"
      ? { href: "/draft", label: "Draft", icon: "matches" as const }
      : items.some((item) => item.href === "/schedule")
        ? { href: "/schedule", label: "Matches", icon: "matches" as const }
        : { href: "/inhouse", label: "Inhouse", icon: "matches" as const },
    {
      href: myTeamHref ?? (hasTeams ? "/teams" : "/players"),
      label: myTeamHref ? "My Team" : hasTeams ? "Teams" : "Players",
      icon: "team" as const,
    },
  ];

  return (
    <>
      <header
        ref={headerRef}
        className="sticky top-0 z-30 border-b border-line/80 bg-bg/80 backdrop-blur"
      >
        <div className="mx-auto flex h-20 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Link
            href="/"
            aria-label="GGD2L — home"
            className="flex shrink-0 items-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {/* Tight-cropped emblem (glow/margins trimmed) sized to nearly fill
              the bar so there's minimal top/bottom padding. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/ggd2l-logo-nav.png"
              alt="GGD2L"
              width={520}
              height={427}
              className="h-[76px] w-auto"
            />
          </Link>

          {/* Internal pages need league context without making users scroll to
            the footer or open the phone menu. Keep it inside the existing
            80px header (draft-room sticky offsets depend on that height) and
            hide it only on the narrowest screens, where the menu still carries
            the same name + phase. */}
          {pathname !== "/" && seasonName && phase ? (
            <Link
              href="/"
              aria-label={`League status: ${seasonName} — ${PHASE_LABEL[phase] ?? phase}`}
              className="hidden shrink-0 items-center gap-2 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:flex"
              title={`${seasonName} · ${PHASE_LABEL[phase] ?? phase}`}
            >
              <Badge tone={PHASE_TONE[phase] ?? "neutral"}>
                {PHASE_LABEL[phase] ?? phase}
              </Badge>
              <span className="hidden max-w-28 truncate text-xs text-muted 2xl:inline">
                {seasonName}
              </span>
            </Link>
          ) : null}

          {/* Inline nav — only when there's room (xl+). Below that it collapses
            into the menu button so links never get cut off. "Home" is omitted
            inline (the logo is the home link) and the list scrolls rather than
            overlapping the account cluster if space still runs out. */}
          <nav
            aria-label="Primary"
            className="hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden xl:flex"
          >
            {items
              .filter((item) => item.href !== "/")
              .map((item) => {
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
          <div className="flex-1 xl:hidden" />

          {/* Evergreen club/discovery pages stay reachable on wide screens too.
            The phone menu already exposes these below the phase navigation. */}
          <div className="relative hidden xl:block">
            <button
              ref={exploreButtonRef}
              type="button"
              aria-expanded={desktopExploreOpen}
              aria-controls="desktop-explore-nav"
              onClick={() => setDesktopExploreOpen((value) => !value)}
              className={cn(
                "rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-surface-2/60 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
                exploreActive ? "bg-accent/15 text-fg" : "text-muted",
              )}
            >
              Explore <span aria-hidden>{desktopExploreOpen ? "↑" : "↓"}</span>
            </button>
            {desktopExploreOpen ? (
              <nav
                id="desktop-explore-nav"
                aria-label="Explore"
                className="absolute right-0 top-full z-40 mt-3 max-h-[70vh] w-[34rem] overflow-y-auto rounded-xl border border-line bg-surface p-4 shadow-xl shadow-black/30"
              >
                <ExploreLinks
                  items={exploreItems}
                  pathname={pathname}
                  myTeamHref={myTeamHref}
                  onNavigate={() => setDesktopExploreOpen(false)}
                />
              </nav>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            {/* Season phase/name lives on the home hero + footer, not here — it
              kept the nav from fitting once the league adds its links. */}
            {user ? (
              <>
                {user.role === "ADMIN" ? (
                  <Link
                    href="/admin"
                    aria-current={adminActive ? "page" : undefined}
                    className={cn(
                      "hidden rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 xl:block",
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
                  // Below xl the name is hidden and this is an unlabeled 30px
                  // pill — give assistive tech its destination.
                  aria-label={`My profile — ${user.name}`}
                  className="flex min-h-11 items-center gap-2 rounded-full border border-line py-1 pl-1 pr-1 text-sm hover:border-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:min-h-0 xl:pr-3"
                >
                  <Avatar name={user.name} src={user.avatar} size={28} />
                  <span className="hidden max-w-[8rem] truncate xl:block">
                    {user.name}
                  </span>
                </Link>
                <form
                  action="/api/auth/logout"
                  method="POST"
                  className="hidden xl:inline"
                >
                  <button
                    type="submit"
                    className="rounded text-sm text-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                    title="Log out"
                  >
                    Logout
                  </button>
                </form>
              </>
            ) : pathname !== "/login" ? (
              <Link
                // Carry the current page through sign-in — landing back on the
                // dashboard after every login was a pointless extra hop.
                href={
                  pathname && pathname !== "/"
                    ? `/login?next=${encodeURIComponent(pathname)}`
                    : "/login"
                }
                className="inline-flex min-h-11 items-center rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-fg hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:min-h-0 sm:px-4"
              >
                Sign in
              </Link>
            ) : null}

            {/* Menu toggle — only below xl, where the inline nav is hidden. */}
            <button
              ref={buttonRef}
              type="button"
              onClick={() => {
                const next = !open || mobilePanel !== "menu";
                setMobilePanel("menu");
                setOpen(next);
                if (!next) setMobileExploreOpen(false);
              }}
              aria-label={
                open && mobilePanel === "menu" ? "Close menu" : "Open menu"
              }
              aria-expanded={open && mobilePanel === "menu"}
              aria-controls="mobile-nav"
              className="grid h-11 w-11 place-items-center rounded-lg text-muted hover:bg-surface-2/60 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:h-9 sm:w-9 xl:hidden"
            >
              {open && mobilePanel === "menu" ? <CloseIcon /> : <MenuIcon />}
            </button>
          </div>
        </div>

        {/* Mobile dropdown: holds every nav link + account actions so nothing is
          ever clipped. Overlays content (absolute) to avoid a layout jump. */}
        {open && mobilePanel === "menu" ? (
          <nav
            id="mobile-nav"
            aria-label="Primary"
            className="absolute inset-x-0 top-full max-h-[min(70vh,calc(100dvh-5rem-var(--mobile-dock-height)-0.5rem))] overflow-y-auto overscroll-contain border-b border-line/80 bg-bg/95 shadow-lg backdrop-blur xl:hidden"
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
                      "block rounded-lg px-3 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 sm:py-2.5",
                      active
                        ? "bg-accent/15 text-fg"
                        : "text-muted hover:bg-surface-2/60 hover:text-fg",
                    )}
                  >
                    {item.label}
                  </Link>
                );
              })}

              {/* Explore is a disclosure on phones too; the four dense league
                tools no longer expand the primary menu unless requested. */}
              <div className="mt-1 border-t border-line/80 pt-2">
                <button
                  type="button"
                  aria-expanded={mobileExploreOpen}
                  aria-controls="mobile-explore-nav"
                  onClick={() => setMobileExploreOpen((value) => !value)}
                  className={cn(
                    "flex w-full items-center justify-between rounded-lg px-3 py-3 text-left text-sm font-medium transition-colors hover:bg-surface-2/60 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 sm:py-2.5",
                    exploreActive ? "bg-accent/15 text-fg" : "text-muted",
                  )}
                >
                  Explore
                  <span aria-hidden>{mobileExploreOpen ? "↑" : "↓"}</span>
                </button>
                {mobileExploreOpen ? (
                  <div
                    id="mobile-explore-nav"
                    role="group"
                    aria-label="Explore"
                    className="mt-2 rounded-xl border border-line-soft bg-surface p-3"
                  >
                    <ExploreLinks
                      items={mobileExploreItems}
                      pathname={pathname}
                      myTeamHref={myTeamHref}
                      onNavigate={() => setOpen(false)}
                    />
                  </div>
                ) : null}
              </div>

              {(user?.role === "ADMIN" || user || seasonName) && (
                <div className="mt-1 space-y-1 border-t border-line/80 pt-2">
                  {user?.role === "ADMIN" ? (
                    <Link
                      href="/admin"
                      aria-current={adminActive ? "page" : undefined}
                      className={cn(
                        "block rounded-lg px-3 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 sm:py-2.5",
                        adminActive
                          ? "bg-surface-2 text-accent"
                          : "text-accent/80 hover:bg-surface-2/60 hover:text-accent",
                      )}
                    >
                      Admin
                    </Link>
                  ) : null}
                  {user ? (
                    <Link
                      href="/me"
                      aria-current={
                        isActive(pathname, "/me", null) ? "page" : undefined
                      }
                      className={cn(
                        "block rounded-lg px-3 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 sm:py-2.5",
                        isActive(pathname, "/me", null)
                          ? "bg-accent/15 text-fg"
                          : "text-muted hover:bg-surface-2/60 hover:text-fg",
                      )}
                    >
                      My profile
                    </Link>
                  ) : null}
                  {user ? (
                    <form action="/api/auth/logout" method="POST">
                      <button
                        type="submit"
                        className="block w-full rounded-lg px-3 py-3 text-left text-sm font-medium text-muted hover:bg-surface-2/60 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 sm:py-2.5"
                      >
                        Log out
                      </button>
                    </form>
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
      <nav
        ref={dockRef}
        aria-label="Quick navigation"
        className="mobile-dock fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg/95 px-3 pt-1.5 shadow-[0_-8px_30px_rgba(0,0,0,0.18)] backdrop-blur-xl xl:hidden"
      >
        <div className="mx-auto grid max-w-lg grid-cols-4 gap-1">
          {dockItems.map((item) => {
            const active =
              isActive(pathname, item.href, myTeamHref) ||
              (item.href === "/schedule" && pathname.startsWith("/matches/"));
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                onClick={() => setOpen(false)}
                className={cn(
                  "flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                  active
                    ? "bg-accent/10 text-accent"
                    : "text-muted hover:bg-surface-2 hover:text-fg",
                )}
              >
                <DockIcon name={item.icon} />
                <span>{item.label}</span>
              </Link>
            );
          })}
          <button
            ref={dockExploreRef}
            type="button"
            aria-label="Explore league"
            aria-expanded={open && mobilePanel === "explore"}
            aria-controls="mobile-discovery"
            onClick={() => {
              setOpen(!(open && mobilePanel === "explore"));
              setMobilePanel("explore");
            }}
            className={cn(
              "flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              exploreActive || (open && mobilePanel === "explore")
                ? "bg-accent/10 text-accent"
                : "text-muted hover:bg-surface-2 hover:text-fg",
            )}
          >
            <DockIcon name="explore" />
            <span>Explore</span>
          </button>
        </div>
      </nav>
      {open && mobilePanel === "explore" ? (
        <nav
          ref={discoveryRef}
          id="mobile-discovery"
          aria-label="Explore league"
          className="mobile-discovery fixed inset-x-3 z-40 mx-auto max-h-[calc(100dvh-11rem)] max-w-lg overflow-y-auto overscroll-contain rounded-2xl border border-line bg-surface p-3 shadow-2xl shadow-black/50 xl:hidden"
        >
          <div className="mb-2 flex items-center justify-between border-b border-line-soft pb-2 pl-3">
            <span className="font-display text-lg font-semibold">
              Explore the league
            </span>
            <button
              type="button"
              aria-label="Close explore"
              onClick={() => {
                setOpen(false);
                dockExploreRef.current?.focus();
              }}
              className="grid h-11 w-11 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
            >
              <CloseIcon />
            </button>
          </div>
          <div className="mb-3 grid grid-cols-3 gap-1 border-b border-line-soft pb-3">
            {items
              .filter((item) => !["/", myTeamHref].includes(item.href))
              .map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  aria-current={
                    isActive(pathname, item.href, myTeamHref)
                      ? "page"
                      : undefined
                  }
                  className="flex min-h-11 items-center justify-center rounded-lg bg-surface-2/60 px-2 text-center text-xs font-medium hover:bg-surface-3"
                >
                  {item.label}
                </Link>
              ))}
          </div>
          <ExploreLinks
            items={mobileExploreItems}
            pathname={pathname}
            myTeamHref={myTeamHref}
            onNavigate={() => setOpen(false)}
            compact
          />
        </nav>
      ) : null}
    </>
  );
}

function DockIcon({ name }: { name: "home" | "matches" | "team" | "explore" }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "home" ? (
        <>
          <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" />
        </>
      ) : null}
      {name === "matches" ? (
        <>
          <rect x="3" y="5" width="18" height="16" rx="3" />
          <path d="M7 3v4M17 3v4M3 10h18m-14 5 2 2 4-4M16 15h1" />
        </>
      ) : null}
      {name === "team" ? (
        <>
          <circle cx="9" cy="8" r="3" />
          <path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v3" />
        </>
      ) : null}
      {name === "explore" ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m16 8-2 6-6 2 2-6Z" />
        </>
      ) : null}
    </svg>
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

// Group the existing destinations without changing their season gates or URLs.
const EXPLORE_GROUPS = [
  { label: "Play", paths: ["/scrims", "/fantasy", "/pickem"] },
  {
    label: "Statistics",
    paths: ["/leaders", "/meta", "/players/compare", "/records"],
  },
  {
    label: "League",
    paths: ["/news", "/features", "/hall-of-fame", "/seasons"],
  },
];

function ExploreLinks({
  items,
  pathname,
  myTeamHref,
  onNavigate,
  compact = false,
}: {
  items: NavItem[];
  pathname: string;
  myTeamHref: string | null;
  onNavigate: () => void;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid gap-4",
        compact ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-1 sm:grid-cols-3",
      )}
    >
      {EXPLORE_GROUPS.map((group) => {
        const links = group.paths.flatMap((path) =>
          items.filter((item) => item.href === path),
        );
        if (!links.length) return null;
        return (
          <div
            key={group.label}
            className={cn(
              compact && group.label === "League" && "col-span-2 sm:col-span-1",
            )}
          >
            <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-muted">
              {group.label}
            </p>
            <div
              className={cn(
                compact &&
                  group.label === "League" &&
                  "grid grid-cols-3 gap-1 sm:grid-cols-1",
              )}
            >
              {links.map((item) => {
                const active = isActive(pathname, item.href, myTeamHref);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    onClick={onNavigate}
                    className={cn(
                      "flex min-h-11 items-center rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
                      active
                        ? "bg-accent/15 text-fg"
                        : "text-muted hover:bg-surface-2 hover:text-fg",
                    )}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
