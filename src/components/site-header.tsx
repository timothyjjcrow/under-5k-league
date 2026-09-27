"use client";

import { LEAGUE_CONFIG } from "@/lib/league-config";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Avatar, Badge } from "@/components/ui";
import { MerchLink } from "@/components/merch-link";
import { seasonPhaseTone } from "@/lib/season-copy";
import {
  exploreNav,
  headerStatus,
  phoneDock,
  seasonNav,
  type DockIconName,
  type JoinCta,
  type NavContent,
  type NavLink,
  type NavSection,
} from "@/lib/site-nav";
import { cn } from "@/lib/utils";

type HeaderUser = {
  name: string;
  avatar: string | null;
  role: string;
} | null;

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
  draftStatus = null,
  content,
  join = null,
  seriesLive = false,
}: {
  user: HeaderUser;
  phase: string | null;
  seasonName: string | null;
  myTeamId: string | null;
  /** The active season's auction status; only read during DRAFT. */
  draftStatus?: string | null;
  /** What the league has on record; decides which data pages are offered. */
  content: NavContent;
  /** "Join Season N" during signups, for a viewer who hasn't joined. */
  join?: JoinCta | null;
  /** A match in the active season is LIVE right now. */
  seriesLive?: boolean;
}) {
  const pathname = usePathname();
  // Every list below comes from src/lib/site-nav.ts, which the footer shares:
  // one name, one group and one visibility rule per page.
  const navState = { ...content, phase, draftStatus };
  const items = seasonNav(navState, myTeamId);
  // The logo is the home link on wide screens.
  const desktopItems = items.filter((item) => item.href !== "/");
  const exploreSections = exploreNav(navState);
  const status = headerStatus({ phase, draftStatus, seriesLive });
  const statusPath = status?.href.split("#")[0];
  const myTeamHref = myTeamId ? `/teams/${myTeamId}` : null;
  // Three disclosures: the desktop Explore dropdown, the account menu (every
  // width) and the phone tab bar's sheet. Phones used to add a ☰ menu and an
  // Explore section inside it, which listed the same pages again.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [desktopExploreOpen, setDesktopExploreOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const exploreButtonRef = useRef<HTMLButtonElement>(null);
  const accountButtonRef = useRef<HTMLButtonElement>(null);
  const desktopExploreRef = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const dockExploreRef = useRef<HTMLButtonElement>(null);

  // Close every menu whenever the route changes (e.g. a link was tapped).
  // Adjusted DURING RENDER rather than in an effect: React's documented way to
  // reset state when an input changes, and it avoids the extra committed frame
  // where the menu is still open on the new route.
  const [menuPath, setMenuPath] = useState(pathname);
  if (menuPath !== pathname) {
    setMenuPath(pathname);
    setSheetOpen(false);
    setDesktopExploreOpen(false);
    setAccountOpen(false);
  }

  // Switching between the desktop bar and phone dock must not leave a hidden
  // disclosure open, ready to reappear on the next resize.
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 64rem)");
    function closePanels() {
      setSheetOpen(false);
      setDesktopExploreOpen(false);
      setAccountOpen(false);
    }
    desktop.addEventListener("change", closePanels);
    return () => desktop.removeEventListener("change", closePanels);
  }, []);

  // Escape returns focus to the open menu's own trigger. A press anywhere
  // outside a menu (and outside the tab bar, for the sheet) closes it.
  useEffect(() => {
    if (!sheetOpen && !desktopExploreOpen && !accountOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const returnTo = accountOpen
        ? accountButtonRef.current
        : sheetOpen
          ? dockExploreRef.current
          : exploreButtonRef.current;
      setSheetOpen(false);
      setDesktopExploreOpen(false);
      setAccountOpen(false);
      returnTo?.focus();
    }
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (!desktopExploreRef.current?.contains(target)) {
        setDesktopExploreOpen(false);
      }
      if (!accountRef.current?.contains(target)) {
        setAccountOpen(false);
      }
      if (
        !sheetRef.current?.contains(target) &&
        !dockRef.current?.contains(target)
      ) {
        setSheetOpen(false);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [sheetOpen, desktopExploreOpen, accountOpen]);

  const adminActive = pathname.startsWith("/admin");

  const exploreActive = exploreSections.some((section) =>
    section.links.some((item) => isActive(pathname, item.href, myTeamHref)),
  );
  // Three pages in the tab bar; the sheet behind its last slot lists the rest.
  const dock = phoneDock(items, myTeamHref, join);
  // The signup form is on /me, and /login is already the way there.
  const headerJoin =
    join && pathname !== "/me" && pathname !== "/login" ? join : null;
  const sheetActive =
    exploreActive ||
    dock.sheet.some((item) => isActive(pathname, item.href, myTeamHref));

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-line/80 bg-bg/80 backdrop-blur">
        <div className="mx-auto flex h-20 w-full max-w-7xl items-center gap-2 px-4 sm:gap-3 sm:px-6 xl:gap-4">
          <Link
            href="/"
            aria-label={`${LEAGUE_CONFIG.name} — home`}
            className="flex shrink-0 items-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {/* Regional emblem sized to fit the existing header height. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={LEAGUE_CONFIG.branding.navLogo}
              style={{ mixBlendMode: LEAGUE_CONFIG.branding.blendMode }}
              alt={LEAGUE_CONFIG.name}
              width={LEAGUE_CONFIG.branding.navWidth}
              height={LEAGUE_CONFIG.branding.navHeight}
              className="h-[76px] w-auto"
            />
          </Link>

          {/* What is happening in the league right now, on every width. A
            live draft or series links to it from every page, Home included;
            otherwise the chip names the phase on inner pages and links Home,
            whose hero already says it. Kept inside the 80px header (draft-room
            sticky offsets depend on that height). On a narrow phone the
            label may truncate rather than push the account button off. */}
          {status && seasonName && (status.live || pathname !== "/") ? (
            <Link
              href={status.href}
              aria-label={`League status: ${seasonName} — ${status.label}`}
              aria-current={pathname === statusPath ? "page" : undefined}
              className="flex min-h-11 min-w-0 items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 lg:shrink-0"
              title={`${seasonName} · ${status.label}`}
            >
              <Badge
                tone={status.live ? "danger" : seasonPhaseTone(phase)}
                className="min-w-0 max-w-full"
              >
                {status.live ? (
                  <span aria-hidden className="relative flex h-1.5 w-1.5 shrink-0">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-75 motion-reduce:animate-none" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-danger" />
                  </span>
                ) : null}
                <span className="truncate">
                  {/* The season's name fits beside the label only between
                    phone and desktop widths; the desktop row is full. */}
                  <span className="hidden sm:inline lg:hidden">
                    {seasonName} ·{" "}
                  </span>
                  {status.label}
                </span>
              </Badge>
            </Link>
          ) : null}

          {/* The desktop row fits from 1024px, including a rostered admin in
            draft or postseason. Keep Explore beside its sibling links and
            reserve the right edge for merch and the account menu. */}
          <div className="relative hidden min-w-0 flex-1 items-center gap-1 lg:flex">
            <nav
              aria-label="Primary"
              className="flex shrink-0 items-center gap-0.5 xl:gap-1"
            >
              {desktopItems.map((item) => {
                const active =
                  !exploreActive && isActive(pathname, item.href, myTeamHref);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "inline-flex min-h-10 shrink-0 items-center whitespace-nowrap rounded-lg px-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 xl:px-2.5",
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

            {/* Evergreen club/discovery pages stay reachable on wide screens
              too. On phones they live in the tab bar's sheet. */}
            <div ref={desktopExploreRef} className="shrink-0">
              <button
                ref={exploreButtonRef}
                type="button"
                aria-expanded={desktopExploreOpen}
                aria-controls="desktop-explore-nav"
                onClick={() => {
                  setDesktopExploreOpen((value) => !value);
                  setAccountOpen(false);
                }}
                className={cn(
                  "inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-medium transition-colors hover:bg-surface-2/60 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 xl:px-2.5",
                  exploreActive ? "bg-accent/15 text-fg" : "text-muted",
                )}
              >
                Explore <ChevronIcon open={desktopExploreOpen} />
              </button>
              {desktopExploreOpen ? (
                <nav
                  id="desktop-explore-nav"
                  aria-label="Explore"
                  className="absolute left-0 top-full z-40 mt-3 max-h-[70vh] w-[34rem] max-w-[calc(100vw-3rem)] overflow-y-auto rounded-xl border border-line bg-surface p-4 shadow-xl shadow-black/30"
                >
                  <ExploreLinks
                    sections={exploreSections}
                    pathname={pathname}
                    myTeamHref={myTeamHref}
                    onNavigate={() => setDesktopExploreOpen(false)}
                  />
                </nav>
              ) : null}
            </div>
          </div>

          <div className="flex-1 lg:hidden" />

          {/* During signups, joining is the one thing to do; Merch stays in
            the footer and the phone menu. */}
          {headerJoin ? (
            <Link
              href={headerJoin.href}
              className="hidden min-h-10 shrink-0 items-center whitespace-nowrap rounded-lg bg-brand px-4 text-sm font-medium text-brand-fg hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 lg:inline-flex"
            >
              {headerJoin.label}
            </Link>
          ) : (
            <MerchLink className="hidden lg:inline-flex" />
          )}

          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            {user ? (
              <div ref={accountRef} className="relative">
                {/* One account menu at every width. On phones the avatar alone
                  is the trigger; it used to be a plain link to the profile,
                  with Admin and Log out hidden in the ☰ menu. */}
                <button
                  ref={accountButtonRef}
                  type="button"
                  aria-label={`Account — ${user.name}`}
                  aria-expanded={accountOpen}
                  aria-controls="account-nav"
                  onClick={() => {
                    setAccountOpen((value) => !value);
                    setDesktopExploreOpen(false);
                    setSheetOpen(false);
                  }}
                  className={cn(
                    "flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full border p-1 text-sm transition-colors hover:border-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 lg:min-h-10 lg:pr-2",
                    accountOpen || adminActive || pathname === "/me"
                      ? "border-accent/40 bg-accent/5"
                      : "border-line",
                  )}
                >
                  <Avatar name={user.name} src={user.avatar} size={28} />
                  <span className="hidden max-w-32 truncate xl:block">
                    {user.name}
                  </span>
                  <span className="hidden lg:block">
                    <ChevronIcon open={accountOpen} />
                  </span>
                </button>
                {accountOpen ? (
                  <nav
                    id="account-nav"
                    aria-label="Account"
                    className="absolute right-0 top-full z-40 mt-3 max-h-[calc(100dvh-6rem)] w-64 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain rounded-xl border border-line bg-surface p-2 shadow-xl shadow-black/30"
                  >
                    <p className="mb-1 break-words border-b border-line-soft px-3 pb-3 pt-2 text-sm font-semibold">
                      {user.name}
                    </p>
                    <Link
                      href="/me"
                      onClick={() => setAccountOpen(false)}
                      aria-current={pathname === "/me" ? "page" : undefined}
                      className="flex min-h-11 items-center rounded-lg px-3 text-sm text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
                    >
                      {/* /me's own name: it is the account and signup page;
                          "profile" is the public page under /players. */}
                      My account
                    </Link>
                    {user.role === "ADMIN" ? (
                      <Link
                        href="/admin"
                        onClick={() => setAccountOpen(false)}
                        aria-current={adminActive ? "page" : undefined}
                        className="flex min-h-11 items-center rounded-lg px-3 text-sm text-accent hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
                      >
                        Admin
                      </Link>
                    ) : null}
                    <form
                      action="/api/auth/logout"
                      method="POST"
                      className="mt-1 border-t border-line-soft pt-1"
                    >
                      <button
                        type="submit"
                        className="flex min-h-11 w-full items-center rounded-lg px-3 text-sm text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
                      >
                        Log out
                      </button>
                    </form>
                  </nav>
                ) : null}
              </div>
            ) : pathname !== "/login" ? (
              <Link
                // Carry the current page through sign-in — landing back on the
                // dashboard after every login was a pointless extra hop.
                href={
                  pathname && pathname !== "/"
                    ? `/login?next=${encodeURIComponent(pathname)}`
                    : "/login"
                }
                className={cn(
                  "inline-flex min-h-11 items-center rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:px-4 lg:min-h-10",
                  // Beside the red join button, sign-in is the quiet choice
                  // for players who have already joined. Phones keep it red:
                  // their join button is in the tab bar.
                  headerJoin
                    ? "bg-brand text-brand-fg hover:bg-brand/90 lg:bg-transparent lg:px-2 lg:text-muted lg:hover:bg-surface-2/60 lg:hover:text-fg"
                    : "bg-brand text-brand-fg hover:bg-brand/90",
                )}
              >
                Sign in
              </Link>
            ) : null}
          </div>
        </div>
      </header>
      <nav
        ref={dockRef}
        aria-label="Quick navigation"
        className="mobile-dock fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg/95 px-3 pt-1.5 shadow-[0_-8px_30px_rgba(0,0,0,0.18)] backdrop-blur-xl lg:hidden"
      >
        <div className="mx-auto grid max-w-lg grid-cols-4 gap-1">
          {dock.tabs.map((item) => {
            const active =
              isActive(pathname, item.href, myTeamHref) ||
              (item.href === "/schedule" && pathname.startsWith("/matches/"));
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-label={item.ariaLabel}
                aria-current={active ? "page" : undefined}
                onClick={() => setSheetOpen(false)}
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
            aria-expanded={sheetOpen}
            aria-controls="mobile-discovery"
            onClick={() => {
              setSheetOpen((value) => !value);
              setAccountOpen(false);
            }}
            className={cn(
              "flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              sheetActive || sheetOpen
                ? "bg-accent/10 text-accent"
                : "text-muted hover:bg-surface-2 hover:text-fg",
            )}
          >
            <DockIcon name="explore" />
            <span>Explore</span>
          </button>
        </div>
      </nav>
      {/* The one phone menu: every page the tab bar doesn't hold, the Explore
        groups, then Merch. A solid panel, so the page never shows through. */}
      {sheetOpen ? (
        <nav
          ref={sheetRef}
          id="mobile-discovery"
          aria-label="Explore league"
          className="mobile-discovery fixed inset-x-3 z-40 mx-auto max-h-[calc(100dvh-11rem)] max-w-lg overflow-y-auto overscroll-contain rounded-2xl border border-line bg-surface p-3 shadow-2xl shadow-black/50 lg:hidden"
        >
          <div className="mb-2 flex items-center justify-between border-b border-line-soft pb-2 pl-3">
            <span className="font-display text-lg font-semibold">
              Explore the league
            </span>
            <button
              type="button"
              aria-label="Close explore"
              onClick={() => {
                setSheetOpen(false);
                dockExploreRef.current?.focus();
              }}
              className="grid h-11 w-11 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg"
            >
              <CloseIcon />
            </button>
          </div>
          {dock.sheet.length > 0 ? (
            <div className="mb-3 grid grid-cols-3 gap-1 border-b border-line-soft pb-3">
              {dock.sheet.map((item) => {
                const active = isActive(pathname, item.href, myTeamHref);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setSheetOpen(false)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-h-11 items-center justify-center rounded-lg px-2 text-center text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
                      active
                        ? "bg-accent/15 text-fg"
                        : "bg-surface-2/60 hover:bg-surface-3",
                    )}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
          ) : null}
          <ExploreLinks
            sections={exploreSections}
            pathname={pathname}
            myTeamHref={myTeamHref}
            onNavigate={() => setSheetOpen(false)}
            compact
          />
          <MerchLink className="mt-3 w-full" />
        </nav>
      ) : null}
    </>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={open ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} />
    </svg>
  );
}

function DockIcon({ name }: { name: DockIconName | "explore" }) {
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
      {name === "join" ? (
        <>
          <circle cx="10" cy="8" r="4" />
          <path d="M3 21v-1a7 7 0 0 1 11-5.7M19 14v6m-3-3h6" />
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

function ExploreLinks({
  sections,
  pathname,
  myTeamHref,
  onNavigate,
  compact = false,
}: {
  sections: NavSection[];
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
      {sections.map((section) => {
        const wide = compact && section.group === "league";
        return (
          <div
            key={section.group}
            className={cn(wide && "col-span-2 sm:col-span-1")}
          >
            <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-muted">
              {section.label}
            </p>
            <div
              className={cn(wide && "grid grid-cols-3 gap-1 sm:grid-cols-1")}
            >
              {section.links.map((item: NavLink) => {
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
