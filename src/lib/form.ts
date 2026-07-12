// Small helpers for reading + clamping values out of a FormData safely.

export function str(fd: FormData, key: string, fallback = ""): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : fallback;
}

export function bool(fd: FormData, key: string): boolean {
  const v = fd.get(key);
  return v === "on" || v === "true" || v === "1";
}

export function clampInt(
  fd: FormData,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = fd.get(key);
  const n = typeof raw === "string" ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Read a date submitted by <LocalDatetimeField>: prefer the browser-computed
 * epoch (the raw datetime-local string is timezone-less, and parsing it on the
 * server lands in the SERVER's zone — hours off on the UTC prod host), fall
 * back to the raw string for no-JS submissions. Null when empty/invalid.
 */
export function localDate(
  fd: FormData,
  rawKey: string,
  tsKey: string,
): Date | null {
  const raw = str(fd, rawKey).trim();
  if (!raw) return null; // an emptied input means "clear", whatever ts says
  const ts = Number(str(fd, tsKey));
  if (Number.isFinite(ts) && ts > 0) return new Date(ts);
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
