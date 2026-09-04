"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Old shared /news#id links still resolve when the post moves off page one. */
export function NewsHashLink() {
  const router = useRouter();
  useEffect(() => {
    const resolve = () => {
      let id: string;
      try {
        id = decodeURIComponent(window.location.hash.slice(1));
      } catch {
        return;
      }
      if (!id || document.getElementById(id)) return;
      const url = new URL(window.location.href);
      if (url.searchParams.get("post") === id) return;
      router.replace(
        `/news?${new URLSearchParams({ post: id })}#${encodeURIComponent(id)}`,
      );
    };
    resolve();
    window.addEventListener("hashchange", resolve);
    return () => window.removeEventListener("hashchange", resolve);
  }, [router]);
  return null;
}
