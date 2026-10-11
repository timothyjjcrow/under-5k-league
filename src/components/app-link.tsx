import NextLink from "next/link";
import type { ComponentProps, Ref } from "react";

type NextLinkProps = Omit<ComponentProps<typeof NextLink>, "ref"> & {
  ref?: Ref<HTMLAnchorElement>;
};

/**
 * The site's `<Link>`: `next/link` that never prefetches unless the call site
 * asks for it (`prefetch={null}` restores Next's default, `true` the full
 * route).
 *
 * Next prefetches every link that scrolls into view, and the root
 * `loading.tsx` makes every dynamic page here prefetchable: each visible link
 * cost a server render of the root layout, fetched again on every navigation
 * because a dynamic prefetch has no client cache. On 2026-10-11 one page view
 * sent 15 to 27 of them within a second and a half, 114 of the US site's 125
 * page requests in an hour were prefetches, and each burst spread over four
 * or five instances, starting cold ones. Both leagues share the Vercel Hobby
 * plan's four hours of Active CPU a month. Without the prefetch a click waits
 * for the server's first streamed chunk (the loading skeleton) instead of
 * showing it at once.
 *
 * Import this, never `next/link` (`app-link.test.ts`).
 */
export default function Link({ prefetch = false, ...props }: NextLinkProps) {
  return <NextLink prefetch={prefetch} {...(props as ComponentProps<typeof NextLink>)} />;
}
