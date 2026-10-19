import { inhouseQueueShareImage } from "@/components/og-share-images";
import { OG_SIZE } from "@/lib/og-image";

// The queue invite link's picture (/inhouse?join=1 names it in its metadata;
// there is no page here): how full the inhouse queue is, who's in it, and
// whether a game is live. Drawn per request, since it follows the queue.
export const dynamic = "force-dynamic";
export const size = OG_SIZE;
export const contentType = "image/png";
export const alt = "The inhouse queue: how full it is, who's in it, and a link that joins it";

export default async function Image() {
  return inhouseQueueShareImage();
}
