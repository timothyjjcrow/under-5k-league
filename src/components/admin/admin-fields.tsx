

// ---------- small helpers ----------

export const inputCls =
  "h-10 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-accent/60";

// min-w-0 + max-w-full are load-bearing, not cosmetic: a <select> sizes itself
// to its widest <option>, and as a flex item its default min-width:auto refuses
// to shrink below that. Options here are "<player name> (<team>)", so one
// 32-char Steam name (Steam's own cap) pushed the whole admin page ~116px wider
// than a 375px phone. Keep these on any select whose options carry user text.
export const selectCls =
  "h-9 min-w-0 max-w-full rounded-md border border-line bg-surface-2/50 px-2 text-sm outline-none focus:border-accent/60";

export function SeriesField({
  label,
  name,
  value,
  options,
}: {
  label: string;
  name: string;
  value: number;
  options: number[];
}) {
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-xs text-muted">
        {label}
      </label>
      <select id={name} name={name} defaultValue={value} className={selectCls}>
        {options.map((n) => (
          <option key={n} value={n}>
            Best of {n}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}
