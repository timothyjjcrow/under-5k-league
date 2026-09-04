"use client";

import { useId, useMemo, useState } from "react";
import type { HeroMetaRow } from "@/lib/hero-meta";
import { Card, CardBody, CardHeader, PlayerLink } from "@/components/ui";

type Row = HeroMetaRow & {
  name: string;
  signatureName: string;
  signatureUserId: string | null;
};

export function HeroMetaExplorer({ rows }: { rows: Row[] }) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [minimum, setMinimum] = useState("1");
  const [sort, setSort] = useState("picks");
  const visible = useMemo(
    () =>
      rows
        .filter(
          (row) =>
            row.name.toLowerCase().includes(search.trim().toLowerCase()) &&
            row.picks >= Math.max(1, Number(minimum) || 1),
        )
        .sort(
          (a, b) =>
            (sort === "name"
              ? a.name.localeCompare(b.name)
              : sort === "winRate"
                ? b.winRate - a.winRate
                : sort === "kda"
                  ? b.kda - a.kda
                  : b.picks - a.picks) ||
            b.picks - a.picks ||
            a.name.localeCompare(b.name),
        ),
    [rows, search, minimum, sort],
  );
  const input =
    "min-h-11 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm";
  return (
    <Card>
      <CardHeader
        headingLevel={2}
        title="Explore every picked hero"
        subtitle="Search the full analyzed pool. Win rates use the displayed pick count; small samples vary more."
      />
      <CardBody className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <label htmlFor={`${id}-search`} className="space-y-1 text-sm">
            <span>Hero search</span>
            <input
              id={`${id}-search`}
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className={input}
              placeholder="Find a hero…"
            />
          </label>
          <label htmlFor={`${id}-minimum`} className="space-y-1 text-sm">
            <span>Minimum picks</span>
            <input
              id={`${id}-minimum`}
              type="number"
              min="1"
              step="1"
              value={minimum}
              onChange={(event) => setMinimum(event.target.value)}
              className={input}
            />
          </label>
          <label htmlFor={`${id}-sort`} className="space-y-1 text-sm">
            <span>Sort heroes</span>
            <select
              id={`${id}-sort`}
              value={sort}
              onChange={(event) => setSort(event.target.value)}
              className={input}
            >
              <option value="picks">Most picked</option>
              <option value="winRate">Highest win rate</option>
              <option value="kda">Highest KDA</option>
              <option value="name">Hero name</option>
            </select>
          </label>
        </div>
        <p role="status" className="text-xs text-muted">
          {visible.length} of {rows.length} heroes · Scroll the table to see
          every metric.
        </p>
        <div
          role="region"
          aria-label="All hero metrics"
          tabIndex={0}
          className="overflow-x-auto rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <table
            className="w-full min-w-[640px] text-sm"
            aria-label="All picked heroes"
          >
            <thead>
              <tr className="border-b border-line text-left text-muted">
                {[
                  "Hero",
                  "Picks",
                  "Pick rate",
                  "W–L",
                  "Win rate",
                  "KDA",
                  "Signature player",
                ].map((label) => (
                  <th key={label} scope="col" className="px-2 py-3">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr
                  key={row.heroId}
                  className="border-b border-line/50 tabular-nums"
                >
                  <th scope="row" className="px-2 py-3 text-left font-medium">
                    {row.name}
                  </th>
                  <td className="px-2">{row.picks}</td>
                  <td className="px-2">{row.pickRate}%</td>
                  <td className="px-2">
                    {row.wins}–{row.losses}
                  </td>
                  <td className="px-2">{row.winRate}%</td>
                  <td className="px-2">{row.kda}</td>
                  <td className="px-2">
                    {row.topPlayer && row.signatureUserId ? (
                      <PlayerLink userId={row.signatureUserId}>
                        {row.signatureName} ({row.topPlayer.wins}–
                        {row.topPlayer.games - row.topPlayer.wins})
                      </PlayerLink>
                    ) : row.topPlayer ? (
                      `Former player (${row.topPlayer.wins}–${row.topPlayer.games - row.topPlayer.wins})`
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length === 0 ? (
            <p className="py-4 text-sm text-muted">
              No heroes match these filters. Lower the minimum or clear your
              search.
            </p>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}
