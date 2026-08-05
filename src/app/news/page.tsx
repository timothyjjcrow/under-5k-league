import { prisma } from "@/lib/prisma";
import { formatMatchTime } from "@/lib/match-time";
import { shareMetadata } from "@/lib/share-metadata";
import { LocalTime } from "@/components/local-time";
import {
  Badge,
  Card,
  CardBody,
  EmptyState,
  LinkifiedText,
  PageTitle,
} from "@/components/ui";

export const metadata = shareMetadata(
  "League news",
  "Official GGD2L announcements, league updates, and administrator notices.",
  "/news",
);

export default async function NewsPage() {
  const posts = await prisma.newsPost.findMany({
    include: { author: { select: { name: true } } },
    orderBy: [{ pinned: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  });

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
            <article key={p.id} id={p.id} className="scroll-mt-24">
              <Card>
                <CardBody>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="min-w-0 flex-1 font-display text-lg font-semibold [overflow-wrap:anywhere]">
                      {p.title}
                    </h2>
                    {p.pinned && <Badge tone="accent">📌 Pinned</Badge>}
                    <a
                      href={`#${p.id}`}
                      className="-m-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-sm text-muted hover:bg-surface-2 hover:text-info focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                      aria-label={`Permalink to “${p.title}”`}
                      title={`Permalink to “${p.title}”`}
                    >
                      #
                    </a>
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    <LocalTime
                      ts={p.createdAt.getTime()}
                      variant="full"
                      initial={formatMatchTime(p.createdAt, "full")}
                    />
                    {p.author ? ` · ${p.author.name}` : ""}
                  </div>
                  <LinkifiedText
                    text={p.body}
                    mediaLabel={`Media attached to “${p.title}”`}
                    className="mt-3 block [overflow-wrap:anywhere] whitespace-pre-wrap text-sm leading-relaxed text-fg/90"
                  />
                </CardBody>
              </Card>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
