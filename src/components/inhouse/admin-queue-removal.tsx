"use client";

import { useId, useState } from "react";
import { buttonClasses } from "@/components/ui";
import { pushToast } from "@/components/toaster";
import { queueRemovalChoices } from "@/lib/inhouse";
import type { InhouseState } from "@/lib/inhouse-service";

/**
 * Admin: take a player out of the queue (`removeFromQueue`, action
 * `remove`). One picker for everyone queued, since a slot's own button would
 * miss the players no slot shows (away, or "Also queued" past the ten) and
 * the whole queue while the admin is in a game; the room shows it to admins
 * under the stage whenever anyone is queued. Not a ban: the confirm says they
 * can join again.
 */
export function AdminQueueRemoval({
  queue,
  pending,
  act,
}: {
  queue: InhouseState["queue"];
  pending: boolean;
  act: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const id = useId();
  const [choice, setChoice] = useState("");
  const choices = queueRemovalChoices(queue);
  // A player who left (or went into a game) since the pick is no choice.
  const picked = choices.find((c) => c.userId === choice) ?? null;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {/* On a phone the label takes its own line, leaving the picker the row. */}
      <label htmlFor={id} className="w-full text-right text-xs text-muted sm:w-auto">
        Admin: remove from the queue
      </label>
      <select
        id={id}
        value={picked ? picked.userId : ""}
        onChange={(e) => setChoice(e.target.value)}
        disabled={pending}
        className="h-10 min-w-0 max-w-full flex-1 rounded-lg border border-line bg-surface-2/50 px-2 text-sm text-fg sm:h-8 sm:max-w-xs sm:flex-none"
      >
        <option value="">Choose a player…</option>
        {choices.map((c) => (
          <option key={c.userId} value={c.userId}>
            {c.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={pending || !picked}
        onClick={async () => {
          if (!picked) return;
          if (
            !window.confirm(
              `Remove ${picked.name} from the inhouse queue? They lose their place and can join again.`,
            )
          ) {
            return;
          }
          // Only claim success once the server agrees: they may have left or
          // gone into a game since the pick.
          if (await act({ action: "remove", userId: picked.userId })) {
            pushToast("success", `${picked.name} is out of the queue`);
            setChoice("");
          }
        }}
        className={buttonClasses("ghost", "sm", "text-danger hover:text-danger")}
      >
        Remove
      </button>
    </div>
  );
}
