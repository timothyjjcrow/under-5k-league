"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Refresh the server-rendered Pick'em partition when the next open fixture
 * locks. The button leaf handles the exact millisecond locally; this refresh
 * moves the whole card into locked review and reveals the now-public split.
 */
export function PickemDeadlineRefresh({ targetMs }: { targetMs: number }) {
  const router = useRouter();

  useEffect(() => {
    const remaining = targetMs - Date.now();
    if (remaining <= 0) {
      router.refresh();
      return;
    }
    const id = window.setTimeout(
      () => router.refresh(),
      Math.min(remaining, 2_147_483_647),
    );
    return () => window.clearTimeout(id);
  }, [router, targetMs]);

  return null;
}
