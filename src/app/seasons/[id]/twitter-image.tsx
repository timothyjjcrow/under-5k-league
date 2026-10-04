import { seasonShareImage } from "@/components/og-share-images";
import { OG_SIZE } from "@/lib/og-image";

// The link preview picture (Discord, X, Slack): drawn per request, since it
// follows the live data, and cached for five minutes by its own header.
export const dynamic = "force-dynamic";
export const size = OG_SIZE;
export const contentType = "image/png";
export const alt = "The season: its phase, size and champion";

export default async function Image({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return seasonShareImage((await params).id);
}
