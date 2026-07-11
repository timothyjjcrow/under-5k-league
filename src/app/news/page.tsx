import { prisma } from "@/lib/prisma";
import { sortNews } from "@/lib/news";
import { formatMatchTime } from "@/lib/match-time";
import { LocalTime } from "@/components/local-time";
import {
  Badge,
  Card,
  CardBody,
  EmptyState,
  PageTitle,
} from "@/components/ui";

export const metadata = { title: "News" };

export default async function NewsPage() {
  const posts = sortNews(
    await prisma.newsPost.findMany({
      include: { author: { select: { name: true } } },
    }),
  );

  return (
    <div className="space-y-6">
      <PageTitle
        title="League news"
        subtitle="Announcements from the league admins"
      />
      {posts.length === 0 ? (
        <EmptyState
          title="Nothing yet"
          description="Announcements land here when the admins have news."
        />
      ) : (
        <div className="space-y-4">
          {posts.map((p) => (
            <Card key={p.id}>
              <CardBody>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="min-w-0 flex-1 truncate font-display text-lg font-semibold">
                    {p.title}
                  </h2>
                  {p.pinned && <Badge tone="accent">📌 Pinned</Badge>}
                </div>
                <div className="mt-0.5 text-xs text-muted">
                  <LocalTime
                    ts={p.createdAt.getTime()}
                    variant="full"
                    initial={formatMatchTime(p.createdAt, "full")}
                  />
                  {p.author ? ` · ${p.author.name}` : ""}
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-fg/90">
                  {p.body}
                </p>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
