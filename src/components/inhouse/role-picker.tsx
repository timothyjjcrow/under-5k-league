"use client";

import { useId } from "react";
import { buttonClasses } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  DOTA_ROLES,
  parseRoleOrder,
  rolePreferenceLine,
  serializeRoleOrder,
  type InhouseRolesSource,
} from "@/lib/roles";

/**
 * The five position toggles beside the queue's Join button, so captains can
 * see who plays what when they draft. Pick as many as you like, in the order
 * you want to play them: the first tapped is your first choice, and taking one
 * out keeps the others' order. Controlled: the room holds the unsaved choice
 * and QueueControls saves it with Join or "Save positions". The digits are
 * what Dota players say ("pos 1"); each toggle's full name (with its rank) is
 * its accessible name, and the line under them spells the order out for
 * phones, where a hover title never shows.
 */
export function RolePicker({
  value,
  onChange,
  source,
  disabled = false,
  queueCard = false,
}: {
  /** The preference order ("2,3,1"; "" = none picked). */
  value: string;
  onChange: (next: string) => void;
  /**
   * Where the shown choice came from, for the "from your league signup" note
   * (the caller passes "inhouse" once the player has changed it).
   */
  source: InhouseRolesSource;
  disabled?: boolean;
  /**
   * The filled queue card (the whole queue on the first screen): below md
   * and from lg the label, shortened to "Positions" with the rest for screen
   * readers (so the group's name doesn't change), sits beside the toggles
   * with the order line under them, left-aligned on a phone and centred on
   * a desktop. md keeps the stacked picker, with the card's own spacing
   * above it. Off, it renders exactly what shipped.
   */
  queueCard?: boolean;
}) {
  const labelId = useId();
  const keys = parseRoleOrder(value);
  // League signup roles are an unordered set: no ranks until the player
  // picks their own order.
  const ranked = source !== "signup" && keys.length > 1;
  const line = ranked
    ? rolePreferenceLine(value)
    : keys
        .map((k) => DOTA_ROLES.find((r) => r.key === k)!.label)
        .join(", ");
  const toggle = (key: string) =>
    onChange(
      serializeRoleOrder(
        keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key],
      ),
    );

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className={cn(
        "mt-4",
        queueCard &&
          "max-md:mt-0 max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-2 max-md:gap-y-1 md:mt-1 lg:mt-0 lg:flex lg:flex-wrap lg:items-center lg:justify-center lg:gap-x-3 lg:gap-y-1",
      )}
    >
      <p id={labelId} className="text-center text-xs font-medium text-muted">
        {queueCard ? (
          <>
            Positions
            <span className="max-md:sr-only lg:sr-only"> you play, in the order you want them</span>
          </>
        ) : (
          "Positions you play, in the order you want them"
        )}
      </p>
      <div className={cn("mt-2 flex justify-center gap-2", queueCard && "max-md:mt-0 lg:mt-0")}>
        {DOTA_ROLES.map((role) => {
          const rank = keys.indexOf(role.key) + 1;
          const on = rank > 0;
          return (
            <button
              key={role.key}
              type="button"
              aria-pressed={on}
              aria-label={`${role.short} · ${role.label}${
                on && ranked ? `, choice ${rank}` : ""
              }`}
              title={role.label}
              disabled={disabled}
              onClick={() => toggle(role.key)}
              className={buttonClasses(
                on ? "accent" : "secondary",
                "md",
                "relative w-11 px-0 tabular-nums",
              )}
            >
              {role.key}
              {on && ranked ? (
                <span
                  aria-hidden
                  className="absolute -right-1.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full border border-accent bg-bg px-0.5 text-[10px] font-semibold leading-none text-accent"
                >
                  {rank}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <p
        className={cn(
          "mt-1.5 text-center text-xs text-muted",
          queueCard && "max-md:mt-0 max-md:basis-full max-md:text-left lg:mt-0 lg:basis-full",
        )}
      >
        {line || "None picked yet: tap your favorite first"}
        {source === "signup" && line ? " · from your league signup" : null}
      </p>
    </div>
  );
}
