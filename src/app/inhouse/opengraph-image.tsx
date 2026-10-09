import { inhouseShareImage } from "@/components/og-share-images";
import { OG_SIZE } from "@/lib/og-image";

// The link preview picture (Discord, X, Slack): the planned inhouse night, so
// its invite link unfurls as the night; the league's own picture otherwise.
// Drawn per request, since it follows the live night and headcount.
export const dynamic = "force-dynamic";
export const size = OG_SIZE;
export const contentType = "image/png";
export const alt = "The inhouse night: when it is, who's coming and how to say you're in";

export default async function Image() {
  return inhouseShareImage();
}
