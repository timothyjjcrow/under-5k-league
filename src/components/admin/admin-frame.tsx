import { redirect } from "next/navigation";
import Link from "@/components/app-link";
import { EmptyState, PageTitle, buttonClasses } from "@/components/ui";
import { SectionHashReveal } from "@/components/section-nav";
import { cn } from "@/lib/utils";
import {
  ADMIN_SECTION_TAB,
  ADMIN_TABS,
  adminTab,
  type AdminTabId,
} from "@/lib/admin-tabs";

/**
 * What an admin route renders for a viewer who may not see it: the sign-in
 * page (back to `path` afterwards) for nobody, and an access notice for a
 * signed-in non-admin. Every admin tab calls it before reading anything.
 */
export function AdminGateScreen({
  gate,
  path,
}: {
  gate: "anonymous" | "denied";
  path: string;
}) {
  // `path` is one of the fixed admin routes, so it needs no escaping.
  if (gate === "anonymous") redirect(`/login?next=${path}`);
  return (
    <div className="space-y-8">
      <PageTitle
        title="Admin access required"
        subtitle="This area is limited to league administrators."
      />
      <EmptyState
        title="You do not have administrator access"
        description="Your account is signed in, but it is not on the administrator allowlist. Ask a league administrator if you believe this is a mistake."
        action={
          <Link href="/" className={buttonClasses("secondary")}>
            Return to league home
          </Link>
        }
      />
    </div>
  );
}

/**
 * The admin's tabs, in one fixed order on every admin page. Each shows how
 * many to-dos it holds (from Overview's list), so the work is visible from
 * any tab. Wraps onto a second row on a phone rather than hiding tabs off
 * the edge, and pins under the site header from desktop width.
 */
export function AdminTabs({
  active,
  counts = {},
}: {
  active: AdminTabId;
  counts?: Partial<Record<AdminTabId, number>>;
}) {
  return (
    <nav
      aria-label="Admin sections"
      className="border-b border-line-soft bg-bg/95 pb-2 lg:sticky lg:top-16 lg:z-20 lg:backdrop-blur"
    >
      <ul className="flex flex-wrap gap-1">
        {ADMIN_TABS.map((tab) => {
          const current = tab.id === active;
          const count = counts[tab.id] ?? 0;
          return (
            <li key={tab.id}>
              <Link
                href={tab.path}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:px-3 lg:min-h-10",
                  current
                    ? "border-accent/60 bg-accent/10 text-fg"
                    : "border-transparent text-muted hover:bg-surface-2 hover:text-fg",
                )}
              >
                {tab.label}
                {count > 0 ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="min-w-5 rounded-full bg-accent/20 px-1.5 text-center text-xs font-semibold leading-5 text-accent tabular-nums"
                    >
                      {count}
                    </span>
                    {/* The bar's flex gap reads as a space, so the
                        link's name is "People (1 to do)". */}
                    <span className="sr-only">{`(${count} to do)`}</span>
                  </>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The anchors of the cards a tab renders (ADMIN_SECTION_TAB). */
function tabAnchors(tab: AdminTabId): string[] {
  return Object.entries(ADMIN_SECTION_TAB)
    .filter(([, owner]) => owner === tab)
    .map(([id]) => id);
}

/**
 * One admin tab: the page title, the tab bar and the tab's cards, 20px
 * apart. A link to one of the tab's cards opens and scrolls to it, folded or
 * not, the way the one-page admin's jump bar did; inside a card only its
 * folded AdminSection opens (`openNested="marked"`), never a danger fold or
 * an edit form.
 */
export function AdminFrame({
  tab,
  counts,
  children,
}: {
  tab: AdminTabId;
  counts: Partial<Record<AdminTabId, number>>;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-5">
      <PageTitle title="Admin" subtitle={adminTab(tab).subtitle} />
      <AdminTabs active={tab} counts={counts} />
      <SectionHashReveal ids={tabAnchors(tab)} openNested="marked" />
      {children}
    </div>
  );
}
