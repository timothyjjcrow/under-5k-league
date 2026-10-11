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
  phoneRow = false,
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
   * The filled queue card (the whole queue on the first screen). Below md
   * it sits beside the card's MMR box or status, so the label is for screen
   * readers only, the toggles are 40px high and share the row's width (34px
   * at 390, 31 at 375, up to 40 on a wider phone; 8px apart) and the order line is
   * one line under them, cut off with an ellipsis when it doesn't fit (the
   * toggles' rank badges and names carry the order). From lg the label,
   * shortened to "Positions" with the rest for screen readers (so the
   * group's name doesn't change), sits beside the toggles with the order
   * line under them, centred. md keeps the stacked picker, with the card's
   * own spacing above it. Off, it renders exactly what shipped.
   */
  queueCard?: boolean;
  /**
   * The empty queue's card on a phone (below md): the short "Positions"
   * label beside 40px toggles and the order line under them, centred, so
   * the card keeps a phone's first screen. md and up render exactly what
   * shipped.
   */
  phoneRow?: boolean;
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

  // A phone's short label and line: the full ones from md (both are the
  // same words for a screen reader at every width).
  const shortLabel = queueCard || phoneRow;
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className={cn(
        "mt-4",
        queueCard &&
          "max-md:mt-0 md:mt-1 lg:mt-0 lg:flex lg:flex-wrap lg:items-center lg:justify-center lg:gap-x-3 lg:gap-y-1",
        phoneRow &&
          "max-md:mt-3 max-md:flex max-md:flex-wrap max-md:items-center max-md:justify-center max-md:gap-x-2 max-md:gap-y-1",
      )}
    >
      <p
        id={labelId}
        className={cn(
          "text-center text-xs font-medium text-muted",
          queueCard && "max-md:sr-only",
        )}
      >
        {shortLabel ? (
          <>
            Positions
            <span className={cn("max-md:sr-only", queueCard && "lg:sr-only")}>
              {" "}
              you play, in the order you want them
            </span>
          </>
        ) : (
          "Positions you play, in the order you want them"
        )}
      </p>
      <div
        className={cn(
          "mt-2 flex justify-center gap-2",
          queueCard && "max-md:mt-0 max-md:justify-start lg:mt-0",
          phoneRow && "max-md:mt-0",
        )}
      >
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
                cn(
                  "relative w-11 px-0 tabular-nums",
                  // 40px high on a phone (the kit's small control there).
                  (queueCard || phoneRow) && "max-md:h-10",
                  // Beside the card's context cell: up to 40px wide, giving
                  // way on a narrower phone (8px apart at every width).
                  queueCard && "max-md:w-auto max-md:min-w-0 max-md:max-w-10 max-md:flex-1",
                  // The picked (accent) variant has no border: a transparent
                  // one keeps all five the same width, so a tap never shifts them.
                  on && queueCard && "max-md:border max-md:border-transparent",
                  phoneRow && "max-md:w-10",
                ),
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
          queueCard && "max-md:mt-1 max-md:truncate max-md:text-left lg:mt-0 lg:basis-full",
          phoneRow && "max-md:mt-0 max-md:basis-full",
        )}
      >
        {line || (
          <>
            {/* A phone's line is shorter: the toggles are the "pick". */}
            <span className={cn(shortLabel && "max-md:hidden")}>None picked yet: tap</span>
            {shortLabel ? <span className="md:hidden">Tap</span> : null}
            {" your favorite first"}
          </>
        )}
        {source === "signup" && line ? (
          <>
            {" · from your "}
            <span className={cn(shortLabel && "max-md:hidden")}>league </span>
            signup
          </>
        ) : null}
      </p>
    </div>
  );
}
