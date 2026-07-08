"use client";

import { useMemo, useState } from "react";
import { HEROES, type Hero, heroIcon, parseHeroList } from "@/lib/heroes";
import { buttonClasses } from "@/components/ui";
import { cn } from "@/lib/utils";

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Searchable multi-select for Dota heroes. Writes the chosen heroes' canonical
 * names into a hidden input (comma-separated) so it drops into the existing
 * `favoriteHeroes` form field with no server-side change.
 */
export function HeroPicker({
  name,
  defaultValue,
  max = 12,
}: {
  name: string;
  defaultValue?: string | null;
  max?: number;
}) {
  const [selected, setSelected] = useState<Hero[]>(
    () => parseHeroList(defaultValue).matched,
  );
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const selectedIds = useMemo(
    () => new Set(selected.map((h) => h.id)),
    [selected],
  );
  const results = useMemo(() => {
    const q = norm(query);
    const list = q
      ? HEROES.filter((h) => norm(h.name).includes(q) || norm(h.key).includes(q))
      : HEROES;
    return list.slice(0, 60);
  }, [query]);

  const atMax = selected.length >= max;
  const value = selected.map((h) => h.name).join(", ");

  function toggle(hero: Hero) {
    setSelected((cur) => {
      if (cur.some((h) => h.id === hero.id)) {
        return cur.filter((h) => h.id !== hero.id);
      }
      if (cur.length >= max) return cur;
      return [...cur, hero];
    });
  }

  return (
    <div>
      <input type="hidden" name={name} value={value} />

      {selected.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {selected.map((h) => (
            <button
              type="button"
              key={h.id}
              onClick={() => toggle(h)}
              title={`Remove ${h.name}`}
              className="group flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 py-1 pl-1 pr-2 text-xs font-medium"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={heroIcon(h)}
                alt=""
                width={20}
                height={20}
                style={{ width: 20, height: 20 }}
                className="rounded"
              />
              {h.name}
              <span className="text-muted transition-colors group-hover:text-danger">
                ×
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={buttonClasses("secondary", "sm")}
        >
          + Add heroes
        </button>
      ) : (
        <div className="rounded-lg border border-line bg-surface-2/30 p-2">
          <div className="relative mb-2">
            <input
              type="text"
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search heroes…"
              className="h-9 w-full rounded-md border border-line bg-surface-2/50 pl-3 pr-8 text-sm outline-none focus:border-accent/60"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg"
              >
                ✕
              </button>
            ) : null}
          </div>
          <div className="grid max-h-56 grid-cols-2 gap-1 overflow-y-auto sm:grid-cols-3">
            {results.map((h) => {
              const isSel = selectedIds.has(h.id);
              const disabled = !isSel && atMax;
              return (
                <button
                  type="button"
                  key={h.id}
                  disabled={disabled}
                  onClick={() => toggle(h)}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    isSel
                      ? "bg-accent/15 ring-1 ring-accent/40"
                      : "hover:bg-surface-2",
                    disabled ? "opacity-40" : "",
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={heroIcon(h)}
                    alt=""
                    width={22}
                    height={22}
                    style={{ width: 22, height: 22 }}
                    className="shrink-0 rounded"
                  />
                  <span className="truncate">{h.name}</span>
                </button>
              );
            })}
            {results.length === 0 ? (
              <p className="col-span-full p-2 text-sm text-muted">
                No heroes match &ldquo;{query}&rdquo;.
              </p>
            ) : null}
          </div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-muted">
              {selected.length}/{max} selected
            </span>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setQuery("");
              }}
              className={buttonClasses("ghost", "sm")}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
