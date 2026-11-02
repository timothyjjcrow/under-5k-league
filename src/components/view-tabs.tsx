"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

/**
 * Tabs for one card's views of the same thing (Schedule's standings: the
 * table, the head-to-head grid, the playoff race). The server renders every
 * panel; the inactive ones are `hidden`, so the first view shows before
 * hydration. `<ViewTabList>` sits in the card's header and each
 * `<ViewTabPanel>` in its body, joined by context.
 *
 * A tab with an `anchor` takes that id, so a link to `#head-to-head` (and
 * the schedule's jump bar, which focuses its target) lands on the tab and
 * selects it: tabs activate on focus, as the ARIA tabs pattern's automatic
 * activation does.
 */
export type ViewTab = { key: string; label: string; anchor?: string };

const Ctx = createContext<{
  tabs: ViewTab[];
  selected: string;
  select: (key: string) => void;
  idBase: string;
} | null>(null);

function useTabs() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("ViewTabList and ViewTabPanel need a <ViewTabs>.");
  return ctx;
}

export function ViewTabs({
  tabs,
  children,
}: {
  tabs: ViewTab[];
  children: ReactNode;
}) {
  const [selected, setSelected] = useState(tabs[0]?.key ?? "");
  const idBase = useId();
  useEffect(() => {
    // The URL's hash names a tab when someone shares or follows a link to it.
    const fromHash = () => {
      const hash = window.location.hash.slice(1);
      const tab = tabs.find((t) => t.anchor && t.anchor === hash);
      if (tab) setSelected(tab.key);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [tabs]);
  return (
    <Ctx.Provider value={{ tabs, selected, select: setSelected, idBase }}>
      {children}
    </Ctx.Provider>
  );
}

const tabId = (idBase: string, tab: ViewTab) =>
  tab.anchor ?? `${idBase}-tab-${tab.key}`;
const panelId = (idBase: string, key: string) => `${idBase}-panel-${key}`;

export function ViewTabList({
  label,
  className,
}: {
  /** The tablist's accessible name ("Standings views"). */
  label: string;
  className?: string;
}) {
  const { tabs, selected, select, idBase } = useTabs();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const at = tabs.findIndex((t) => t.key === selected);
      const next =
        event.key === "ArrowRight"
          ? (at + 1) % tabs.length
          : event.key === "ArrowLeft"
            ? (at - 1 + tabs.length) % tabs.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabs.length - 1
                : null;
      if (next === null) return;
      event.preventDefault();
      // Focusing the tab selects it (onFocus below).
      buttons.current.get(tabs[next].key)?.focus();
    },
    [tabs, selected],
  );
  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex max-w-full shrink-0 gap-0.5 self-center rounded-lg border border-line bg-surface-2/40 p-0.5",
        className,
      )}
    >
      {tabs.map((tab) => {
        const active = tab.key === selected;
        return (
          <button
            key={tab.key}
            ref={(node) => {
              if (node) buttons.current.set(tab.key, node);
              else buttons.current.delete(tab.key);
            }}
            type="button"
            role="tab"
            id={tabId(idBase, tab)}
            aria-selected={active}
            aria-controls={panelId(idBase, tab.key)}
            tabIndex={active ? 0 : -1}
            onClick={() => select(tab.key)}
            onFocus={() => select(tab.key)}
            className={cn(
              // scroll-mt clears the sticky header when a link lands here.
              "h-10 scroll-mt-24 whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:h-8",
              active
                ? "bg-accent/15 text-accent"
                : "text-muted hover:bg-surface-2 hover:text-fg",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export function ViewTabPanel({
  tab,
  children,
  className,
}: {
  tab: string;
  children: ReactNode;
  className?: string;
}) {
  const { tabs, selected, idBase } = useTabs();
  const owner = tabs.find((t) => t.key === tab);
  return (
    <div
      role="tabpanel"
      id={panelId(idBase, tab)}
      aria-labelledby={owner ? tabId(idBase, owner) : undefined}
      hidden={tab !== selected}
      className={className}
    >
      {children}
    </div>
  );
}
