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
