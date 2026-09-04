"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

function revealSection(id: string, focus: boolean) {
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
  const nested = target.querySelector("details");
  if (nested) nested.open = true;
  if (focus) {
    const heading =
      target.querySelector<HTMLElement>("summary, h2, h3") ?? target;
    const tabIndex = heading.getAttribute("tabindex");
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    if (tabIndex === null) heading.removeAttribute("tabindex");
    else heading.setAttribute("tabindex", tabIndex);
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

/** Native anchors remain usable before hydration; enhanced jumps open details. */
export function SectionNav({
  items,
  label,
  sticky = false,
}: {
  items: { id: string; label: string }[];
  label: string;
  sticky?: boolean;
}) {
  const [active, setActive] = useState("");
  const resolvedHash = useRef("");
  useEffect(() => {
    const observed = new Set<string>();
    resolvedHash.current = "";
    const resolveHash = () => {
      const id = window.location.hash.slice(1);
      if (
        id &&
        id !== resolvedHash.current &&
        items.some((item) => item.id === id) &&
        revealSection(id, false)
      ) {
        resolvedHash.current = id;
        setActive(id);
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-145px 0px -55% 0px" },
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
    const onHashChange = () => {
      resolvedHash.current = "";
      resolveHash();
    };
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("popstate", onHashChange);
    window.addEventListener("section-ready", observeSections);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("popstate", onHashChange);
      window.removeEventListener("section-ready", observeSections);
    };
  }, [items]);

  return (
    <nav
      aria-label={label}
      className={cn(
        "rounded-xl border border-line bg-bg/95 px-2 py-2",
        sticky && "sticky top-20 z-20 backdrop-blur",
      )}
    >
      <ul className="flex gap-1 overflow-x-auto pb-1">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              aria-current={active === item.id ? "location" : undefined}
              className={cn(
                "inline-flex min-h-11 items-center whitespace-nowrap rounded-lg border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                active === item.id
                  ? "border-accent/60 bg-accent/10 text-fg"
                  : "border-transparent text-muted hover:bg-surface-2 hover:text-fg",
              )}
              onClick={(event) => {
                if (!document.getElementById(item.id)) return;
                event.preventDefault();
                history.pushState(null, "", `#${item.id}`);
                if (revealSection(item.id, true)) resolvedHash.current = item.id;
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
