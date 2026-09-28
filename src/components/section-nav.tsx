"use client";

import { useEffect, useRef, useState } from "react";
import {
  SECTION_BAND_BOTTOM,
  aboveAllSections,
  chipBarEdges,
  chipBarMask,
  revealChipScrollLeft,
  type ChipBarEdges,
} from "@/lib/chip-bar";
import { cn } from "@/lib/utils";

/**
 * Which disclosure inside a jump target opens with it. "first" opens the first
 * `<details>` in the target (a card wrapping a folded body). "marked" opens
 * only a nested `<details data-section-jump>`, so every other disclosure in
 * the card (a danger fold, an edit form, a list) stays as the page rendered it.
 */
type NestedReveal = "first" | "marked";

function revealSection(id: string, focus: boolean, nestedReveal: NestedReveal) {
  const target = document.getElementById(id);
  if (!target) return false;
  const details =
    target instanceof HTMLDetailsElement
      ? target
      : target.querySelector("details");
  if (
    details?.hasAttribute("data-section-jump") &&
    details.dataset.sectionReady !== "true"
  )
    return false;
  // Some destinations are wrappers around details; others are details
  // themselves. Open only that destination and its containing sections.
  let parent: HTMLElement | null = target;
  while (parent) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
    parent = parent.parentElement;
  }
  const nested = target.querySelector<HTMLDetailsElement>(
    nestedReveal === "marked" ? "details[data-section-jump]" : "details",
  );
  if (nested) nested.open = true;
  if (focus) {
    const heading =
      target.querySelector<HTMLElement>("summary, h2, h3") ?? target;
    const tabIndex = heading.getAttribute("tabindex");
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    // Removing tabindex while a non-interactive heading is focused blurs it
    // immediately in Chromium. Keep the programmatic target until focus moves.
    if (tabIndex === null) {
      heading.addEventListener(
        "blur",
        () => heading.removeAttribute("tabindex"),
        { once: true },
      );
    } else heading.setAttribute("tabindex", tabIndex);
  }
  target.scrollIntoView({ behavior: "instant", block: "start" });
  return true;
}

/** A streamed section must hydrate before navigation changes its open state. */
export function SectionReady() {
  const marker = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const section = marker.current?.closest("details");
    if (section) section.dataset.sectionReady = "true";
    window.dispatchEvent(new Event("section-ready"));
    return () => {
      if (section) delete section.dataset.sectionReady;
    };
  }, []);
  return <span ref={marker} hidden />;
}

/**
 * Native anchors remain usable before hydration; enhanced jumps open details.
 *
 * `sticky` pins the bar under the 80px header from desktop width (`lg`) up.
 * Below that it scrolls away with the page: on a phone the header, the tab bar
 * and a pinned chip bar together took a quarter of the screen while reading a
 * match. The header offsets (`top-20`, the draft/inhouse clock bars and their
 * observers) are untouched; only this bar stops pinning.
 */
export function SectionNav({
  items,
  label,
  sticky = false,
  openNested = "first",
  wrap = false,
}: {
  items: { id: string; label: string }[];
  label: string;
  sticky?: boolean;
  /** Which disclosure inside a target opens on a jump (see NestedReveal). */
  openNested?: NestedReveal;
  /**
   * From desktop width (`lg`) the chips wrap onto more rows instead of
   * scrolling sideways: most desktop mice can't scroll sideways, so a bar
   * too long for the width (/admin's) hid half its chips behind the edge
   * fade. Phones keep the one swipeable row. A sticky bar gets taller, so
   * the page's jump targets need a larger desktop scroll offset.
   */
  wrap?: boolean;
}) {
  const [active, setActive] = useState("");
  const resolvedHash = useRef("");
  const listRef = useRef<HTMLUListElement>(null);
  // The server render assumes the bar overflows to the right, which is the
  // phone case the fade exists for; the first measurement corrects it.
  const [edges, setEdges] = useState<ChipBarEdges>({ start: false, end: true });

  // Fade only the sides that really have more chips.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const next = chipBarEdges(list);
      setEdges((prev) =>
        prev.start === next.start && prev.end === next.end ? prev : next,
      );
    };
    measure();
    list.addEventListener("scroll", measure, { passive: true });
    const resize = new ResizeObserver(measure);
    resize.observe(list);
    return () => {
      list.removeEventListener("scroll", measure);
      resize.disconnect();
    };
  }, [items]);

  // Keep the highlighted chip inside the bar as the reader moves down the
  // page. This scrolls the bar sideways only, never the page.
  useEffect(() => {
    const list = listRef.current;
    if (!list || list.scrollWidth <= list.clientWidth) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    // Back above every section: return the bar to its first chip too.
    if (!active) {
      if (list.scrollLeft > 0)
        list.scrollTo({ left: 0, behavior: reduce.matches ? "auto" : "smooth" });
      return;
    }
    const chip = [...list.querySelectorAll<HTMLAnchorElement>("a")].find(
      (link) => link.getAttribute("href") === `#${active}`,
    );
    if (!chip) return;
    const left = revealChipScrollLeft({
      bar: list.getBoundingClientRect(),
      chip: chip.getBoundingClientRect(),
      scrollLeft: list.scrollLeft,
    });
    if (left === null) return;
    list.scrollTo({ left, behavior: reduce.matches ? "auto" : "smooth" });
  }, [active]);
  useEffect(() => {
    const observed = new Set<string>();
    const initialHash = window.location.hash.slice(1);
    let mounted = true;
    resolvedHash.current = "";
    const resolveHash = () => {
      const id = window.location.hash.slice(1);
      if (
        id &&
        id !== resolvedHash.current &&
        items.some((item) => item.id === id) &&
        revealSection(id, false, openNested)
      ) {
        resolvedHash.current = id;
        setActive(id);
      }
    };
    const inBand = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) inBand.add(entry.target.id);
          else inBand.delete(entry.target.id);
        }
        const visible = entries.filter((entry) => entry.isIntersecting);
        if (visible[0]) {
          setActive(visible[0].target.id);
          return;
        }
        const sectionTops = items.flatMap(({ id }) => {
          const target = document.getElementById(id);
          return target ? [target.getBoundingClientRect().top] : [];
        });
        if (
          aboveAllSections({
            anyInBand: inBand.size > 0,
            sectionTops,
            viewportHeight: window.innerHeight,
          })
        )
          setActive("");
      },
      {
        rootMargin: `-145px 0px -${Math.round((1 - SECTION_BAND_BOTTOM) * 100)}% 0px`,
      },
    );
    const observeSections = () => {
      items.forEach(({ id }) => {
        const target = document.getElementById(id);
        if (target && !observed.has(id)) {
          observer.observe(target);
          observed.add(id);
        }
      });
      resolveHash();
    };
    // Async server sections may arrive after the navigation hydrates.
    const mutations = new MutationObserver(observeSections);
    mutations.observe(document.body, { childList: true, subtree: true });
    observeSections();
    // A reload with a hash can restore the old scroll position after the
    // first reveal, leaving the heading behind the sticky header. Reapply
    // the same destination once layout and fonts have settled.
    const revealAfterPaint = () => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!mounted) return;
        const id = window.location.hash.slice(1);
        if (id === initialHash && items.some((item) => item.id === id))
          revealSection(id, false, openNested);
      }));
    };
    if (document.readyState === "complete") revealAfterPaint();
    else window.addEventListener("load", revealAfterPaint, { once: true });
    void document.fonts.ready.then(revealAfterPaint);
    const onHashChange = () => {
      resolvedHash.current = "";
      resolveHash();
    };
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("popstate", onHashChange);
    window.addEventListener("section-ready", observeSections);
    return () => {
      mounted = false;
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener("load", revealAfterPaint);
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("popstate", onHashChange);
      window.removeEventListener("section-ready", observeSections);
    };
  }, [items, openNested]);

  return (
    <nav
      aria-label={label}
      className={cn(
        // From sm the box hugs its chips: four chips in a full-width box
        // read as an empty card between the page's hero and its first
        // section. max-w-full keeps a longer bar at the page width, where
        // it scrolls (or wraps, with `wrap`) as before.
        "max-w-full rounded-xl border border-line bg-bg/95 px-2 py-2 sm:w-fit",
        sticky && "lg:sticky lg:top-20 lg:z-20 lg:backdrop-blur",
      )}
    >
      <ul
        ref={listRef}
        className={cn(
          "flex gap-1 overflow-x-auto pb-1",
          wrap && "lg:flex-wrap lg:overflow-visible lg:pb-0",
        )}
        style={{
          maskImage: chipBarMask(edges),
          WebkitMaskImage: chipBarMask(edges),
        }}
      >
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              aria-current={active === item.id ? "location" : undefined}
              className={cn(
                "inline-flex min-h-11 items-center whitespace-nowrap rounded-lg border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                wrap && "lg:min-h-9",
                active === item.id
                  ? "border-accent/60 bg-accent/10 text-fg"
                  : "border-transparent text-muted hover:bg-surface-2 hover:text-fg",
              )}
              onClick={(event) => {
                if (!document.getElementById(item.id)) return;
                event.preventDefault();
                history.pushState(null, "", `#${item.id}`);
                if (revealSection(item.id, true, openNested))
                  resolvedHash.current = item.id;
                setActive(item.id);
              }}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
