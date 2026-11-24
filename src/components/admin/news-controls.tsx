import { adminTab } from "@/lib/admin-tabs";
import { listPage } from "@/lib/list-page";
import { randomUUID } from "node:crypto";
import Link from "@/components/app-link";
import { prisma } from "@/lib/prisma";
import {
  createNewsPost,
  deleteNewsPost,
  toggleNewsPin,
  updateNewsPost,
} from "@/app/actions/news";
import { NEWS_LIMITS, newsDiscordCopy, type NewsDiscordCopy } from "@/lib/news";
import { formatLeagueMatchTime } from "@/lib/match-time";
import { LocalTime } from "@/components/local-time";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { CardBody, buttonClasses } from "@/components/ui";
import { Field, inputCls } from "@/components/admin/admin-fields";
import { AdminSection } from "@/components/admin/admin-section";

type NewsPostRow = {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  createdAt: Date;
  author: { name: string } | null;
  discord: NewsDiscordCopy;
};

export async function AdminNews({
  searchParams,
}: {
  searchParams: Promise<{ newsPage?: string | string[] }>;
}) {
  const page = listPage((await searchParams).newsPage);
  const results = await prisma.newsPost.findMany({
    include: { author: { select: { name: true } } },
    orderBy: [{ pinned: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * 20,
    take: 21,
  });
  // Async server component: rendered once per request, so Date.now() has no
  // re-render to disagree with.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  // The stored Discord message id never goes to the client; the card only
  // needs to know which state the copy is in.
  const posts: NewsPostRow[] = results
    .slice(0, 20)
    .map(({ discordMessageId, ...post }) => ({
      ...post,
      discord: newsDiscordCopy(discordMessageId, nowMs),
    }));
  return (
    <div className="space-y-3">
      <NewsControls posts={posts} />
      {/* Only with somewhere to go: an empty nav still took space-y's gap. */}
      {page > 1 || results.length > 20 ? (
        <nav aria-label="Admin news pages" className="flex gap-3 text-sm">
          {page > 1 ? (
            <Link
              href={`${adminTab("discord").path}?newsPage=${page - 1}#adm-news`}
              className={buttonClasses("secondary", "sm")}
            >
              ← Newer posts
            </Link>
          ) : null}
          {results.length > 20 ? (
            <Link
              href={`${adminTab("discord").path}?newsPage=${page + 1}#adm-news`}
              className={buttonClasses("secondary", "sm")}
            >
              Older posts →
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

function NewsControls({ posts }: { posts: NewsPostRow[] }) {
  return (
    <AdminSection
      id="adm-news"
      title="League news"
      subtitle="Announcements shown on the dashboard and /news, and in Discord when you tick it."
    >
      <CardBody className="space-y-4">
        <ActionForm action={createNewsPost} className="space-y-3">
          <input type="hidden" name="requestId" value={randomUUID()} />
          <Field label="Title" htmlFor="newsTitle">
            <input
              id="newsTitle"
              name="title"
              required
              maxLength={NEWS_LIMITS.TITLE_MAX}
              placeholder="Week 3 moved to Thursday"
              className={inputCls}
            />
          </Field>
          <Field label="Post" htmlFor="newsBody">
            <textarea
              id="newsBody"
              name="body"
              required
              rows={4}
              maxLength={NEWS_LIMITS.BODY_MAX}
              placeholder="What the league needs to know…"
              className="w-full rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-sm outline-none focus:border-accent/60"
            />
            <p className="mt-1 text-xs text-muted">
              Drop a GIF link on its own line to embed it on the site and in
              Discord. Easiest: a <strong>Giphy</strong> or{" "}
              <strong>Tenor</strong> page link. Klipy page links don’t embed —
              right-click the GIF → “Copy image address” (a static.klipy.com/…​
              .gif URL) instead. Direct image/GIF/MP4 URLs also work.
            </p>
          </Field>
          <NewsDiscordChoices idSuffix="new" postByDefault />
          <SubmitButton variant="accent">Post announcement</SubmitButton>
        </ActionForm>

        {posts.length > 0 && (
          <ul className="divide-y divide-line/50 border-t border-line/70">
            {posts.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center gap-2 py-2.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {p.pinned ? "📌 " : ""}
                    {p.title}
                  </span>
                  <span className="block text-xs text-muted">
                    <LocalTime
                      ts={p.createdAt.getTime()}
                      variant="short"
                      initial={formatLeagueMatchTime(p.createdAt, "short")}
                    />
                    {p.author ? ` · ${p.author.name}` : ""}
                    {` · ${newsDiscordLabel(p.discord)}`}
                  </span>
                </span>
                <ActionForm action={toggleNewsPin} className="inline">
                  <input type="hidden" name="postId" value={p.id} />
                  <input
                    type="hidden"
                    name="pinned"
                    value={p.pinned ? "false" : "true"}
                  />
                  <SubmitButton variant="secondary" size="sm">
                    {p.pinned ? "Unpin" : "Pin"}
                  </SubmitButton>
                </ActionForm>
                <ActionForm action={deleteNewsPost} className="inline">
                  <input type="hidden" name="postId" value={p.id} />
                  <SubmitButton
                    variant="secondary"
                    size="sm"
                    confirm={`Delete "${p.title}"? This can't be undone.${
                      p.discord.state === "posted"
                        ? " Its Discord copy is removed too."
                        : ""
                    }`}
                  >
                    Delete
                  </SubmitButton>
                </ActionForm>
                {/* Keyed on the text so a saved edit remounts the form with
                    the new text as its defaults (and folds it shut). */}
                <details
                  key={`${p.title}\u0000${p.body}`}
                  className="basis-full"
                >
                  <summary className="cursor-pointer text-xs text-muted hover:text-fg">
                    ✎ Edit
                  </summary>
                  <ActionForm
                    action={updateNewsPost}
                    className="mt-2 space-y-3"
                    hidden={{ postId: p.id }}
                  >
                    <Field label="Title" htmlFor={`newsTitle-${p.id}`}>
                      <input
                        id={`newsTitle-${p.id}`}
                        name="title"
                        required
                        maxLength={NEWS_LIMITS.TITLE_MAX}
                        defaultValue={p.title}
                        className={inputCls}
                      />
                    </Field>
                    <Field label="Post" htmlFor={`newsBody-${p.id}`}>
                      <textarea
                        id={`newsBody-${p.id}`}
                        name="body"
                        required
                        rows={4}
                        maxLength={NEWS_LIMITS.BODY_MAX}
                        defaultValue={p.body}
                        className="w-full rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-sm outline-none focus:border-accent/60"
                      />
                    </Field>
                    {p.discord.state === "posted" ? (
                      <p className="text-xs text-muted">
                        Saving also updates the Discord copy. Edits never ping
                        anyone.
                      </p>
                    ) : p.discord.state === "posting" &&
                      !p.discord.interrupted ? (
                      <p className="text-xs text-muted">
                        A post to Discord is in progress.
                      </p>
                    ) : (
                      <>
                        <p className="text-xs text-muted">
                          {p.discord.state === "posting"
                            ? "An earlier post to Discord was interrupted. Check the channel before posting it again."
                            : "This post has no Discord copy the site can update. Posts from before edits existed may still be in the channel."}
                        </p>
                        <NewsDiscordChoices idSuffix={p.id} />
                      </>
                    )}
                    <SubmitButton variant="secondary" size="sm">
                      Save changes
                    </SubmitButton>
                  </ActionForm>
                </details>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </AdminSection>
  );
}

/** One line on each admin news row: where the post's Discord copy stands. */
function newsDiscordLabel(copy: NewsDiscordCopy): string {
  if (copy.state === "posted") return "on Discord";
  if (copy.state === "posting") {
    return copy.interrupted ? "Discord post interrupted" : "posting to Discord";
  }
  return "not on Discord";
}

/**
 * The two Discord choices on a news form. @everyone is never ticked for the
 * admin: it notifies every member of the server, so it has to be a choice.
 */
function NewsDiscordChoices({
  idSuffix,
  postByDefault = false,
}: {
  idSuffix: string;
  postByDefault?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        <label
          htmlFor={`newsDiscord-${idSuffix}`}
          className="inline-flex items-center gap-2"
        >
          <input
            id={`newsDiscord-${idSuffix}`}
            type="checkbox"
            name="postToDiscord"
            defaultChecked={postByDefault}
            className="h-4 w-4 accent-[var(--color-brand)]"
          />
          Also post to Discord
        </label>
        <label
          htmlFor={`newsEveryone-${idSuffix}`}
          className="inline-flex items-center gap-2"
        >
          <input
            id={`newsEveryone-${idSuffix}`}
            type="checkbox"
            name="pingEveryone"
            className="h-4 w-4 accent-[var(--color-brand)]"
          />
          Ping @everyone
        </label>
      </div>
      <p className="text-xs text-muted">
        @everyone notifies every member of the server, so keep it for news
        everyone has to see. It only applies when the post goes to Discord.
      </p>
    </div>
  );
}
