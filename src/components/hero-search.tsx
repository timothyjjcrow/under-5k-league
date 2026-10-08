"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { heroPagePath, searchHeroes } from "@/lib/heroes";
import { HeroIcon } from "@/components/hero-icon";
import { buttonClasses } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * "Find a hero": type a name or a shorthand ("jugg", "am") and pick from the
 * matches, or press Enter for the best one. Every hero has a page, picked or
 * not. Without scripts the form still works: it GETs /meta/find, which
 * redirects to the best match.
 */
export function HeroSearch({
  seasonId,
  className,
}: {
  /** An archived season's id, kept on the hero page the search opens. */
  seasonId?: string;
  className?: string;
}) {
  const router = useRouter();
  const inputId = useId();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const matches = searchHeroes(query);
  const showList = open && query.trim().length > 0;

  return (
    <form
      role="search"
      aria-label="Hero search"
      action="/meta/find"
      method="get"
      className={cn("relative", className)}
      onSubmit={(event) => {
        event.preventDefault();
        const best = matches[0];
        if (best) router.push(heroPagePath(best, seasonId));
        else setOpen(true);
      }}
      onBlur={(event) => {
        // Close only when focus leaves the whole search (input and list).
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        Find a hero
      </label>
      {seasonId ? <input type="hidden" name="season" value={seasonId} /> : null}
      <div className="flex gap-2">
        <input
          id={inputId}
          name="q"
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Find a hero (try “jugg” or “am”)"
          autoComplete="off"
          aria-controls={showList ? listId : undefined}
          className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-fg placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:h-10"
        />
        <button type="submit" className={buttonClasses("secondary", "md")}>
          Go
        </button>
      </div>
      {showList ? (
        <div
          id={listId}
          className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-line bg-surface-3 shadow-lg shadow-black/30"
        >
          {matches.length > 0 ? (
            <ul aria-label="Matching heroes" className="max-h-80 overflow-y-auto py-1">
              {matches.map((hero) => (
                <li key={hero.id}>
                  <Link
                    href={heroPagePath(hero, seasonId)}
                    prefetch={false}
                    onClick={() => setOpen(false)}
                    className="flex min-h-11 items-center gap-2.5 px-3 text-sm text-fg hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none sm:min-h-10"
                  >
                    <span aria-hidden="true" className="flex shrink-0">
                      <HeroIcon hero={hero} size={24} className="rounded" />
                    </span>
                    <span className="min-w-0 truncate">{hero.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-2.5 text-sm text-muted">
              {`No hero matches “${query.trim()}”.`}
            </p>
          )}
        </div>
      ) : null}
    </form>
  );
}
