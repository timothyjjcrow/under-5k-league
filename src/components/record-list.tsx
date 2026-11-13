"use client";

// One list of the record book (player records, or match records). Each row
// is the record; its toggle opens the marks that came next, so the book shows
// how close the chasers are. The server maps every mark to plain display
// values (records/page.tsx); this component only opens and closes rows.

import { useId, useState } from "react";
import Link from "@/components/app-link";
import { Avatar, PlayerLink, textLink } from "@/components/ui";
import { HeroIcon } from "@/components/hero-icon";
import type { Hero } from "@/lib/heroes";
import { cn } from "@/lib/utils";

export type RecordListMark = {
  /** The mark with its unit: "14", "674 GPM", "54m 49s". */
  value: string;
  matchId: string;
  /** A player record's holder; `id` is null once their profile is gone. */
  player?: {
    id: string | null;
    name: string;
    avatar: string | null;
    isViewer: boolean;
    hero: Hero | null;
    heroName: string;
  };
  /** A match record's fixture and final kill score. */
  game?: { home: string; away: string } | { home: null; away: null };
  score?: string;
  /** The mark's season, named only in the all-time book. */
  season: string | null;
};

export type RecordListRow = {
  key: string;
  title: string;
  emoji: string;
  /** Best first: the record, then the marks behind it. */
  marks: RecordListMark[];
};

// One grid for the record and the marks under it. Phone: title and value on
// the first line, who and the match link on the second, the toggle beside
// both. sm and up: one line, with the title track wide enough for the longest
// titles ("Most tower damage", "Most kills in defeat") beside their emoji.
const ROW =
  "grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 sm:grid-cols-[13rem_7rem_minmax(0,1fr)_auto]";
// The toggle sits beside the grid, not in it, so the four cells place
// themselves the same way on a record and on the marks under it.
const LINE = "flex items-center gap-x-1 pl-4 pr-1.5";
const TOGGLE_SLOT = "h-11 w-11 shrink-0";
const WHO = "flex min-w-0 items-center gap-2 text-sm";
// justify-self-end: on a phone every row is its own grid, so the auto track
// is as wide as that row's value ("674 GPM") and a left-aligned link sat at a
// different x on every row.
const MATCH_LINK = textLink("shrink-0 justify-self-end text-xs font-semibold");

const ORDINAL = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"];

export function RecordList({ rows }: { rows: RecordListRow[] }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const listId = useId();
  return (
    <ul className="divide-y divide-line-soft">
      {rows.map((row) => {
        const [record, ...chasers] = row.marks;
        const open = openKey === row.key;
        const panelId = `${listId}-${row.key}`;
        return (
          <li key={row.key}>
            <div className={cn(LINE, "py-1.5 sm:py-0.5")}>
              <div className={ROW}>
                <span className="min-w-0 truncate text-sm font-semibold">
                  <span aria-hidden="true">{row.emoji} </span>
                  {row.title}
                </span>
                <span className="text-right font-display text-lg font-bold tabular-nums sm:text-left">
                  {record.value}
                </span>
                <MarkWho mark={record} />
                <Link href={`/matches/${record.matchId}`} className={MATCH_LINK}>
                  Match →
                </Link>
              </div>
              {chasers.length > 0 ? (
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={panelId}
                  aria-label={`${open ? "Hide" : "Show"} the next best: ${row.title}`}
                  onClick={() => setOpenKey(open ? null : row.key)}
                  className={cn(
                    TOGGLE_SLOT,
                    "grid place-items-center rounded-lg text-muted hover:bg-surface-2/70 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                  )}
                >
                  <svg
                    aria-hidden
                    viewBox="0 0 16 16"
                    fill="none"
                    className={cn(
                      "h-4 w-4 transition-transform motion-reduce:transition-none",
                      open && "rotate-180",
                    )}
                  >
                    <path
                      d="m4 6 4 4 4-4"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              ) : (
                <span className={TOGGLE_SLOT} />
              )}
            </div>
            {open ? (
              <ol
                id={panelId}
                aria-label={`Next best: ${row.title}`}
                className="border-t border-line-soft bg-surface-2/30 py-1"
              >
                {chasers.map((mark, index) => (
                  <li key={`${mark.matchId}-${index}`} className={cn(LINE, "py-2 sm:py-1.5")}>
                    <div className={ROW}>
                      <span className="min-w-0 pl-6 text-xs font-medium uppercase tracking-wide text-muted">
                        {ORDINAL[index + 1] ?? `${index + 2}th`}
                      </span>
                      <span className="text-right text-sm font-semibold tabular-nums sm:text-left">
                        {mark.value}
                      </span>
                      <MarkWho mark={mark} />
                      <Link href={`/matches/${mark.matchId}`} className={MATCH_LINK}>
                        Match →
                      </Link>
                    </div>
                    <span className="w-11 shrink-0" />
                  </li>
                ))}
              </ol>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function MarkWho({ mark }: { mark: RecordListMark }) {
  const { player, game } = mark;
  if (player) {
    return (
      <span className={WHO}>
        <Avatar name={player.name} src={player.avatar} size={24} className="shrink-0" />
        {player.id ? (
          <PlayerLink userId={player.id} className="truncate font-medium">
            {player.name}
          </PlayerLink>
        ) : (
          <span className="truncate font-medium text-muted">{player.name}</span>
        )}
        {player.isViewer ? (
          <span className="shrink-0 rounded bg-info/15 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-info-soft">
            You
          </span>
        ) : null}
        <span className="flex shrink-0 items-center gap-1.5 text-muted">
          {player.hero ? (
            <span aria-hidden="true" className="flex">
              <HeroIcon hero={player.hero} size={20} />
            </span>
          ) : null}
          <span className="sr-only min-[400px]:not-sr-only">{player.heroName}</span>
        </span>
        {mark.season ? (
          <span className="hidden truncate text-xs text-muted md:inline">· {mark.season}</span>
        ) : null}
      </span>
    );
  }
  return (
    <span className={cn(WHO, "text-muted")}>
      {/* The matchup is which game this was, so each team truncates on its
          own and the opponent wraps to a second line when both don't fit: a
          two-line clamp over the whole string cut a long home team off
          mid-name and never reached the opponent. */}
      {game?.home != null ? (
        <span className="flex min-w-0 flex-wrap gap-x-1 text-fg">
          <span className="min-w-0 max-w-full truncate">{game.home}</span>
          <span className="min-w-0 max-w-full truncate">
            <span className="text-muted">vs</span> {game.away}
          </span>
        </span>
      ) : (
        <span className="min-w-0 truncate text-fg">League match</span>
      )}
      {mark.score ? <span className="shrink-0 tabular-nums">· {mark.score}</span> : null}
      {mark.season ? (
        <span className="hidden truncate text-xs md:inline">· {mark.season}</span>
      ) : null}
    </span>
  );
}
