import { inhouseShareImage } from "@/components/og-share-images";
import { OG_SIZE } from "@/lib/og-image";

// X's copy of the inhouse night picture (opengraph-image.tsx beside it).
export const dynamic = "force-dynamic";
export const size = OG_SIZE;
export const contentType = "image/png";
export const alt = "The inhouse night: when it is, who's coming and how to say you're in";

export default async function Image() {
  return inhouseShareImage();
}
