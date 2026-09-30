import Link from "next/link";
import { cache } from "react";
import { LocalTime } from "@/components/local-time";
import { NewsMedia } from "@/components/news-media";
import {
  Card,
  CardBody,
  CardHeader,
  LinkArrow,
  LinkifiedText,
  textLink,
} from "@/components/ui";
import { firstMedia } from "@/lib/linkify";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";

// Admin announcements, in two parts: the pinned posts ride the strip under
// the hero, and the League news card lists the latest of the rest, so a pinned
// post is never shown twice. Each part is capped at three; /news has them all.
// News has no season, so the offseason view renders both too.
const loadHomeNews = cache(async () => {
  const newest = [{ createdAt: "desc" as const }, { id: "desc" as const }];
  const [pinned, latest] = await Promise.all([
    prisma.newsPost.findMany({
      where: { pinned: true },
      orderBy: newest,
      take: 3,
      select: { id: true, title: true },
    }),
    prisma.newsPost.findMany({
      where: { pinned: false },
      orderBy: newest,
      take: 3,
    }),
  ]);
  return { pinned, latest };
});

export async function PinnedNotices({ className }: { className?: string }) {
  const { pinned: posts } = await loadHomeNews();
  if (!posts.length) return null;
  return (
    <aside
      aria-label="Pinned announcements"
      className={cn(
        "rounded-lg border border-accent/30 bg-accent/5 px-4 py-2 text-sm",
        className,
      )}
    >
      {posts.map((post) => (
        <Link
          key={post.id}
          href={`/news?${new URLSearchParams({ post: post.id })}`}
          className="block py-2 text-fg hover:text-info"
        >
          <span aria-hidden="true">📌</span> Pinned notice: {post.title}{" "}
          <LinkArrow />
        </Link>
      ))}
    </aside>
  );
}

export async function LeagueNews({ className }: { className?: string }) {
  const { latest: posts } = await loadHomeNews();
  if (posts.length === 0) return null;

  return (
    <Card className={className}>
      <CardHeader
        headingLevel={2}
        title="League news"
        subtitle="The latest from the admins"
        action={
          <Link href="/news" className={textLink("text-sm")}>
            All news <LinkArrow />
          </Link>
        }
      />
      <CardBody className="space-y-4">
        {posts.map((p) => {
          // Render the GIF below the clamped text, not inside it — a block embed
          // inside a -webkit-line-clamp box breaks the clamp. Capped shorter than
          // /news so three previews stay tidy.
          const media = firstMedia(p.body);
          return (
            <div key={p.id} className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <h3 className="min-w-0 truncate text-sm font-semibold">
                  <Link
                    href={`/news?${new URLSearchParams({ post: p.id })}#${p.id}`}
                    className="hover:text-info"
                  >
                    {p.title}
                  </Link>
                </h3>
                <span className="text-xs text-muted">
                  <LocalTime
                    ts={p.createdAt.getTime()}
                    variant="short"
                    initial={formatLeagueMatchTime(p.createdAt, "short")}
                  />
                </span>
              </div>
              <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-muted">
                <LinkifiedText text={p.body} images="hide" />
              </p>
              {media && (
                <NewsMedia
                  src={media.value}
                  kind={media.kind}
                  label={`Media attached to “${p.title}”`}
                  className="mt-2 block max-h-40 max-w-full rounded-lg border border-line"
                />
              )}
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
}
