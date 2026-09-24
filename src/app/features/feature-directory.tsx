"use client";

import { useId, useState } from "react";
import Link from "next/link";
import type { AvailableTourGroup } from "./tour-content";
import styles from "./features.module.css";

export function FeatureDirectory({ groups }: { groups: AvailableTourGroup[] }) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const words = query
    .trim()
    .toLocaleLowerCase("en")
    .split(/\s+/)
    .filter(Boolean);
  const visibleGroups = groups
    .filter((group) => category === "all" || group.id === category)
    .map((group) => ({
      ...group,
      features: group.features.filter((feature) => {
        const text =
          `${group.label} ${feature.title} ${feature.description}`.toLocaleLowerCase(
            "en",
          );
        return words.every((word) => text.includes(word));
      }),
    }))
    .filter((group) => group.features.length > 0);
  const total = groups.reduce(
    (count, group) => count + group.features.length,
    0,
  );
  const count = visibleGroups.reduce(
    (sum, group) => sum + group.features.length,
    0,
  );

  return (
    <div className={styles.directory}>
      <div className={styles.directoryTools}>
        <div className={styles.search}>
          <label htmlFor={searchId}>Find a feature</label>
          <div className={styles.searchField}>
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <circle cx="10.5" cy="10.5" r="6.5" />
              <path d="m16 16 5 5" />
            </svg>
            <input
              id={searchId}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Try scouting, scrims, fantasy…"
              autoComplete="off"
            />
          </div>
        </div>
        <p
          className={styles.resultCount}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {count} of {total} features
        </p>
      </div>
      <div
        className={styles.filters}
        role="group"
        aria-label="Feature categories"
      >
        {[{ id: "all", label: "All features" }, ...groups].map((group) => (
          <button
            type="button"
            key={group.id}
            aria-pressed={category === group.id}
            onClick={() => setCategory(group.id)}
          >
            {group.label}
          </button>
        ))}
      </div>
      <div className={styles.directoryResults}>
        {visibleGroups.map((group) => (
          <section key={group.id} aria-labelledby={`directory-${group.id}`}>
            <h3
              id={`directory-${group.id}`}
              className={styles.directoryGroupTitle}
            >
              {group.label}
            </h3>
            <div className={styles.directoryGrid}>
              {group.features.map((feature) => (
                <article key={feature.title} className={styles.directoryItem}>
                  <h4>{feature.title}</h4>
                  <p>{feature.description}</p>
                  {feature.availability.available ? (
                    <Link
                      href={feature.href}
                      prefetch={false}
                      className={styles.directoryLink}
                    >
                      {feature.linkLabel} <span aria-hidden="true">↗</span>
                    </Link>
                  ) : (
                    <p className={styles.availability}>
                      {feature.availability.unavailableReason}
                    </p>
                  )}
                </article>
              ))}
            </div>
          </section>
        ))}
        {count === 0 ? (
          <div className={styles.noResults}>
            <h3>No features found</h3>
            <p>Try a different phrase or search across every category.</p>
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setCategory("all");
              }}
            >
              Reset filters
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
