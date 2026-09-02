/**
 * The cached automation preflight is deliberately versioned. Bump both the
 * value and key when the persisted snapshot shape or deadline rules change.
 * This module stays dependency-free so mutation paths can import the tag
 * without initializing Prisma or Next's cache implementation in tests.
 */
export const AUTOMATION_GATE_VERSION = 5 as const;
export const AUTOMATION_GATE_CACHE_KEY = "automation-gate-v5";
export const AUTOMATION_GATE_TAG = "automation-gate:v5";

/** Even a completely quiet site is re-checked at least this often. */
export const AUTOMATION_GATE_HARD_HORIZON_MS = 60 * 60_000;
