import { redirect } from "next/navigation";
import { singleSearchParam } from "@/lib/search-params";
import { adminHref } from "@/lib/admin-tabs";

/**
 * Inhouse players moved onto the Inhouse tab on 2026-11-24 (the card with
 * the search, the queue and recent lists, and the bans). Old links and the
 * inhouse room's admin link land there, keeping a search. The tab gates the
 * viewer.
 */
export default async function InhousePlayersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const raw = singleSearchParam((await searchParams).q);
  const search = raw ? raw.slice(0, 100) : "";
  const [path, hash] = adminHref("adm-inhouse-players").split("#");
  redirect(`${path}${search ? `?q=${encodeURIComponent(search)}` : ""}#${hash}`);
}
