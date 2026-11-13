"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { buttonClasses } from "@/components/ui";

type Option = { id: string; name: string };

const SELECT =
  "mt-1 block h-11 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm text-fg outline-none focus:border-accent/60 sm:h-10";

/**
 * The comparison's two player pickers. Choosing the second player (or
 * changing either once both are set) opens the matchup at once; the Compare
 * button stays for a page whose scripts haven't loaded, where the plain GET
 * form still works.
 */
export function ComparePicker({
  players,
  defaultA,
  defaultB,
}: {
  players: Option[];
  defaultA: string;
  defaultB: string;
}) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);

  function open() {
    const data = form.current ? new FormData(form.current) : null;
    const a = data?.get("a");
    const b = data?.get("b");
    if (typeof a !== "string" || typeof b !== "string" || !a || !b) return;
    router.push(`/players/compare?${new URLSearchParams({ a, b })}`, {
      scroll: false,
    });
  }

  return (
    <form
      ref={form}
      method="get"
      action="/players/compare"
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        open();
      }}
    >
      {(
        [
          ["a", "Player A", defaultA],
          ["b", "Player B", defaultB],
        ] as const
      ).map(([name, label, value]) => (
        <label key={name} className="min-w-[12rem] flex-1 text-xs text-muted">
          {label}
          <select
            name={name}
            defaultValue={value}
            onChange={open}
            className={SELECT}
          >
            <option value="" disabled>
              Pick a player…
            </option>
            {players.map((player) => (
              <option key={player.id} value={player.id}>
                {player.name}
              </option>
            ))}
          </select>
        </label>
      ))}
      <button type="submit" className={buttonClasses("accent")}>
        Compare
      </button>
    </form>
  );
}
