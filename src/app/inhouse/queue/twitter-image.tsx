import { inhouseQueueShareImage } from "@/components/og-share-images";
import { OG_SIZE } from "@/lib/og-image";

// X's copy of the queue invite picture (opengraph-image.tsx beside it).
export const dynamic = "force-dynamic";
export const size = OG_SIZE;
export const contentType = "image/png";
export const alt = "The inhouse queue: how full it is, who's in it, and a link that joins it";

export default async function Image() {
  return inhouseQueueShareImage();
}
