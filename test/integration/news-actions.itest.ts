import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(),
  requireUser: vi.fn(),
  getSessionUser: vi.fn(),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  postNewsToDiscord: vi.fn(),
  editNewsOnDiscord: vi.fn(),
  deleteNewsFromDiscord: vi.fn(),
}));

import { revalidatePath } from "next/cache";
import {
  createNewsPost,
  deleteNewsPost,
  toggleNewsPin,
  updateNewsPost,
} from "@/app/actions/news";
import { getSessionUser, requireAdmin } from "@/lib/auth";
import {
  deleteNewsFromDiscord,
  editNewsOnDiscord,
  postNewsToDiscord,
} from "@/lib/discord";
import { newsDiscordPostingMark } from "@/lib/news";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { prisma } from "@/lib/prisma";
import { makeUser, ON_POSTGRES, raceN, sessionFor } from "./factories";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const DISCORD_ID = "1379001234567890123";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function createForm(
  requestId = REQUEST_ID,
  extra: Record<string, string> = { postToDiscord: "on" },
): FormData {
  return form({
    requestId,
    title: "Week 3 moved",
    body: "Games are Thursday at 8 PM.",
    ...extra,
  });
}

beforeEach(async () => {
  // The shared reset owns NewsPost isolation too; leaving cleanup here would
  // hide a regression where fixture reseeds start leaking old announcements.
  const admin = await makeUser("News Admin", "ADMIN");
  const session = sessionFor(admin);
  vi.mocked(requireAdmin).mockReset();
  vi.mocked(requireAdmin).mockResolvedValue(session);
  vi.mocked(getSessionUser).mockReset();
  vi.mocked(getSessionUser).mockResolvedValue(session);
  vi.mocked(postNewsToDiscord).mockReset();
  vi.mocked(postNewsToDiscord).mockResolvedValue({ ok: true, id: DISCORD_ID });
  vi.mocked(editNewsOnDiscord).mockReset();
  vi.mocked(editNewsOnDiscord).mockResolvedValue("ok");
  vi.mocked(deleteNewsFromDiscord).mockReset();
  vi.mocked(deleteNewsFromDiscord).mockResolvedValue(true);
  vi.mocked(revalidatePath).mockReset();
});
afterEach(() => setRaceHook(null));

describe("news admin actions", () => {
  it("rejects every mutation for a non-admin", async () => {
    const admin = await prisma.user.findFirstOrThrow();
    const post = await prisma.newsPost.create({
      data: { title: "Keep", body: "Still here", authorId: admin.id },
    });
    vi.mocked(requireAdmin).mockRejectedValue(new Error("unauthorized"));

    const results = await Promise.all([
      createNewsPost({}, createForm()),
      toggleNewsPin({}, form({ postId: post.id, pinned: "true" })),
      deleteNewsPost({}, form({ postId: post.id })),
      updateNewsPost(
        {},
        form({ postId: post.id, title: "Changed", body: "Changed" }),
      ),
    ]);

    expect(results.every((result) => result?.error === "Not authorized")).toBe(
      true,
    );
    expect(await prisma.newsPost.count()).toBe(1);
    expect(
      (await prisma.newsPost.findUniqueOrThrow({ where: { id: post.id } }))
        .pinned,
    ).toBe(false);
    expect(
      (await prisma.newsPost.findUniqueOrThrow({ where: { id: post.id } }))
        .title,
    ).toBe("Keep");
    expect(postNewsToDiscord).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("validates content, create tokens, record ids, and explicit pin intent", async () => {
    expect(
      (
        await createNewsPost(
          {},
          form({ requestId: REQUEST_ID, title: "", body: "Body" }),
        )
      )?.error,
    ).toMatch(/title/i);
    expect(
      (await createNewsPost({}, createForm("stale-token")))?.error,
    ).toMatch(/expired/i);
    expect(
      (await toggleNewsPin({}, form({ postId: "bad id", pinned: "true" })))
        ?.error,
    ).toMatch(/invalid post/i);

    const admin = await prisma.user.findFirstOrThrow();
    const post = await prisma.newsPost.create({
      data: { title: "Intent", body: "Body", authorId: admin.id },
    });
    expect(
      (await toggleNewsPin({}, form({ postId: post.id, pinned: "toggle" })))
        ?.error,
    ).toMatch(/invalid pin/i);
    expect(
      (await prisma.newsPost.findUniqueOrThrow({ where: { id: post.id } }))
        .pinned,
    ).toBe(false);
    expect(postNewsToDiscord).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("creates once, awaits Discord, refreshes only news surfaces, and logs the actor", async () => {
    const result = await createNewsPost({}, createForm());

    expect(result?.error).toBeUndefined();
    expect(result?.message).toMatch(/live on the dashboard/i);
    expect(result?.message).toMatch(/in Discord too\.$/);
    const post = await prisma.newsPost.findFirstOrThrow();
    expect(post.title).toBe("Week 3 moved");
    // The Discord message id is kept, so an edit or delete can reach it.
    expect(post.discordMessageId).toBe(DISCORD_ID);
    expect(postNewsToDiscord).toHaveBeenCalledTimes(1);
    expect(postNewsToDiscord).toHaveBeenCalledWith(
      expect.stringContaining(`/news#${post.id}`),
      false,
    );
    expect(vi.mocked(revalidatePath).mock.calls).toEqual([
      ["/"],
      ["/news"],
      ["/admin"],
    ]);
    const audit = await prisma.adminAction.findFirstOrThrow();
    expect(audit).toMatchObject({
      actorName: "News Admin",
      action: "createNewsPost",
    });
    expect(audit.summary).toMatch(/Week 3 moved/);
  });

  it("reports partial success when Discord delivery fails, and frees the post to retry", async () => {
    vi.mocked(postNewsToDiscord).mockResolvedValueOnce({
      ok: false,
      reason: "failed",
    });

    const result = await createNewsPost({}, createForm());

    expect(result?.error).toBeUndefined();
    expect(result?.message).toMatch(
      /Discord delivery couldn't be confirmed.*use Edit to post it again/i,
    );
    const post = await prisma.newsPost.findFirstOrThrow();
    expect(post.discordMessageId).toBeNull();
    expect(await prisma.adminAction.count()).toBe(1);

    // The edit form's "Also post to Discord" is the retry.
    const retry = await updateNewsPost(
      {},
      form({
        postId: post.id,
        title: post.title,
        body: post.body,
        postToDiscord: "on",
      }),
    );
    expect(retry?.message).toBe("It's in Discord too.");
    expect(
      (await prisma.newsPost.findUniqueOrThrow({ where: { id: post.id } }))
        .discordMessageId,
    ).toBe(DISCORD_ID);
    expect(postNewsToDiscord).toHaveBeenCalledTimes(2);
  });

  it("leaves Discord alone unless the box is ticked, and pings @everyone only when asked", async () => {
    const siteOnly = await createNewsPost(
      {},
      createForm("22222222-2222-4222-8222-222222222222", {}),
    );
    expect(siteOnly?.message).toBe(
      "Posted — it's live on the dashboard. It wasn't posted to Discord.",
    );
    expect(postNewsToDiscord).not.toHaveBeenCalled();
    expect(
      (await prisma.newsPost.findFirstOrThrow()).discordMessageId,
    ).toBeNull();

    // @everyone without "post to Discord" means nothing.
    await createNewsPost(
      {},
      createForm("33333333-3333-4333-8333-333333333333", {
        pingEveryone: "on",
      }),
    );
    expect(postNewsToDiscord).not.toHaveBeenCalled();

    const loud = await createNewsPost(
      {},
      createForm("44444444-4444-4444-8444-444444444444", {
        postToDiscord: "on",
        pingEveryone: "on",
      }),
    );
    expect(loud?.message).toMatch(/with an @everyone ping\.$/);
    expect(postNewsToDiscord).toHaveBeenCalledTimes(1);
    expect(vi.mocked(postNewsToDiscord).mock.calls[0][1]).toBe(true);
    const audits = await prisma.adminAction.findMany({
      orderBy: { createdAt: "asc" },
    });
    expect(audits.map((a) => a.summary)).toEqual([
      'Published news post "Week 3 moved" (site only)',
      'Published news post "Week 3 moved" (site only)',
      'Published news post "Week 3 moved" (posted to Discord with @everyone)',
    ]);
  });

  it("says so when no Discord webhook is set", async () => {
    vi.mocked(postNewsToDiscord).mockResolvedValueOnce({
      ok: false,
      reason: "no-webhook",
    });
    const result = await createNewsPost({}, createForm());
    expect(result?.message).toBe(
      "Posted — it's live on the dashboard. No Discord webhook is set, so it wasn't posted there.",
    );
    expect(
      (await prisma.newsPost.findFirstOrThrow()).discordMessageId,
    ).toBeNull();
  });

  it("turns create replays into one post, one send, and one audit entry", async () => {
    const results = await raceN(2, () => createNewsPost({}, createForm()));

    expect(
      results.filter((result) => /already posted/i.test(result?.message ?? "")),
    ).toHaveLength(1);
    expect(await prisma.newsPost.count()).toBe(1);
    expect(
      await prisma.setting.count({
        where: { key: { startsWith: "newsPostRequest:" } },
      }),
    ).toBe(1);
    expect(postNewsToDiscord).toHaveBeenCalledTimes(1);
    expect(await prisma.adminAction.count()).toBe(1);
    // The losing replay also refreshes the stale admin/news payload so the
    // caller converges on the post created by the winner.
    expect(revalidatePath).toHaveBeenCalledTimes(6);
  });

  it("sets pin intent idempotently and audits only the state change", async () => {
    const admin = await prisma.user.findFirstOrThrow();
    const post = await prisma.newsPost.create({
      data: { title: "Important", body: "Read me", authorId: admin.id },
    });
    const first = await toggleNewsPin(
      {},
      form({ postId: post.id, pinned: "true" }),
    );
    const replay = await toggleNewsPin(
      {},
      form({ postId: post.id, pinned: "true" }),
    );

    expect(first?.message).toMatch(/pinned to the top/i);
    expect(replay?.message).toMatch(/already pinned/i);
    expect(
      (await prisma.newsPost.findUniqueOrThrow({ where: { id: post.id } }))
        .pinned,
    ).toBe(true);
    const audits = await prisma.adminAction.findMany();
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("toggleNewsPin");
    expect(audits[0].summary).toMatch(/Pinned.*Important/);
    expect(revalidatePath).toHaveBeenCalledTimes(6);
  });

  it.skipIf(!ON_POSTGRES)(
    "claims one pin transition when two stale admin views submit together",
    async () => {
      const admin = await prisma.user.findFirstOrThrow();
      const post = await prisma.newsPost.create({
        data: { title: "Race bulletin", body: "Read me", authorId: admin.id },
      });
      const originalFind = prisma.newsPost.findUnique.bind(prisma.newsPost);
      let reads = 0;
      let release!: () => void;
      const bothRead = new Promise<void>((resolve) => {
        release = resolve;
      });
      const findSpy = vi
        .spyOn(prisma.newsPost, "findUnique")
        .mockImplementation(
          (async (args: Parameters<typeof originalFind>[0]) => {
            const row = await originalFind(args);
            reads += 1;
            if (reads <= 2) {
              if (reads === 2) release();
              await bothRead;
            }
            return row;
          }) as never,
        );

      let results: Awaited<ReturnType<typeof toggleNewsPin>>[];
      try {
        results = await Promise.all([
          toggleNewsPin({}, form({ postId: post.id, pinned: "true" })),
          toggleNewsPin({}, form({ postId: post.id, pinned: "true" })),
        ]);
      } finally {
        findSpy.mockRestore();
      }

      expect(results.filter((result) => /already pinned/i.test(result?.message ?? ""))).toHaveLength(1);
      expect(await prisma.adminAction.count()).toBe(1);
      expect(
        (await prisma.newsPost.findUniqueOrThrow({ where: { id: post.id } }))
          .pinned,
      ).toBe(true);
    },
  );

  it("makes delete replay-safe and audits only the deletion", async () => {
    const admin = await prisma.user.findFirstOrThrow();
    const post = await prisma.newsPost.create({
      data: { title: "Old update", body: "Remove me", authorId: admin.id },
    });

    const first = await deleteNewsPost({}, form({ postId: post.id }));
    const replay = await deleteNewsPost({}, form({ postId: post.id }));

    expect(first?.message).toBe("Post deleted");
    expect(replay?.message).toBe("Already deleted");
    expect(await prisma.newsPost.count()).toBe(0);
    const audits = await prisma.adminAction.findMany();
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("deleteNewsPost");
    expect(audits[0].summary).toMatch(/Old update/);
    expect(revalidatePath).toHaveBeenCalledTimes(6);
  });

  it("refreshes stale admin views when the referenced post is already gone", async () => {
    const pin = await toggleNewsPin(
      {},
      form({ postId: "already-gone", pinned: "true" }),
    );
    const remove = await deleteNewsPost({}, form({ postId: "already-gone" }));

    expect(pin?.error).toBe("Post not found");
    expect(remove?.message).toBe("Already deleted");
    expect(revalidatePath).toHaveBeenCalledTimes(6);
    expect(await prisma.adminAction.count()).toBe(0);
  });
});

async function existingPost(data: {
  title?: string;
  body?: string;
  discordMessageId?: string | null;
} = {}) {
  const admin = await prisma.user.findFirstOrThrow();
  return prisma.newsPost.create({
    data: {
      title: data.title ?? "Week 4 moved",
      body: data.body ?? "Games are Friday.",
      authorId: admin.id,
      discordMessageId: data.discordMessageId ?? null,
    },
  });
}

async function storedCopy(id: string) {
  return (await prisma.newsPost.findUniqueOrThrow({ where: { id } }))
    .discordMessageId;
}

describe("editing a news post", () => {
  it("updates the site and rewrites the Discord copy instead of posting again", async () => {
    const post = await existingPost({ discordMessageId: DISCORD_ID });

    const result = await updateNewsPost(
      {},
      form({ postId: post.id, title: "Week 4 moved again", body: "Saturday." }),
    );

    expect(result?.message).toBe("Saved. The Discord copy was updated too.");
    const saved = await prisma.newsPost.findUniqueOrThrow({
      where: { id: post.id },
    });
    expect(saved).toMatchObject({
      title: "Week 4 moved again",
      body: "Saturday.",
      discordMessageId: DISCORD_ID,
    });
    expect(postNewsToDiscord).not.toHaveBeenCalled();
    expect(editNewsOnDiscord).toHaveBeenCalledTimes(1);
    expect(vi.mocked(editNewsOnDiscord).mock.calls[0][0]).toBe(DISCORD_ID);
    expect(vi.mocked(editNewsOnDiscord).mock.calls[0][1]).toContain(
      "Week 4 moved again",
    );
    const audit = await prisma.adminAction.findFirstOrThrow();
    expect(audit).toMatchObject({
      action: "updateNewsPost",
      summary: 'Edited news post "Week 4 moved again" (was "Week 4 moved")',
    });
  });

  it("says when Discord refuses the edit, and saving again retries it", async () => {
    const post = await existingPost({ discordMessageId: DISCORD_ID });
    vi.mocked(editNewsOnDiscord).mockResolvedValueOnce("failed");

    const first = await updateNewsPost(
      {},
      form({ postId: post.id, title: "Fixed", body: "Games are Friday." }),
    );
    expect(first?.message).toMatch(/still shows the old text\. Save again/);
    expect(await storedCopy(post.id)).toBe(DISCORD_ID);

    const again = await updateNewsPost(
      {},
      form({ postId: post.id, title: "Fixed", body: "Games are Friday." }),
    );
    expect(again?.message).toBe("The Discord copy was refreshed to match.");
    expect(editNewsOnDiscord).toHaveBeenCalledTimes(2);
    // Only the change that altered the post is in the log.
    expect(await prisma.adminAction.count()).toBe(1);
  });

  it("stops tracking a Discord copy that is gone", async () => {
    const post = await existingPost({ discordMessageId: DISCORD_ID });
    vi.mocked(editNewsOnDiscord).mockResolvedValueOnce("gone");

    const result = await updateNewsPost(
      {},
      form({ postId: post.id, title: "Fixed", body: "Games are Friday." }),
    );

    expect(result?.message).toMatch(/Discord copy is gone/);
    expect(await storedCopy(post.id)).toBeNull();
  });

  it("doesn't post a copy-less post to Discord unless asked", async () => {
    const post = await existingPost();

    const same = await updateNewsPost(
      {},
      form({ postId: post.id, title: post.title, body: post.body }),
    );
    expect(same?.message).toBe("Nothing changed.");

    const edited = await updateNewsPost(
      {},
      form({ postId: post.id, title: "New title", body: post.body }),
    );
    expect(edited?.message).toBe("Saved.");
    expect(postNewsToDiscord).not.toHaveBeenCalled();
    expect(editNewsOnDiscord).not.toHaveBeenCalled();
    expect(await storedCopy(post.id)).toBeNull();
  });

  it("refuses to start a second Discord post while one is in flight", async () => {
    const post = await existingPost({
      discordMessageId: newsDiscordPostingMark(Date.now()),
    });

    const result = await updateNewsPost(
      {},
      form({
        postId: post.id,
        title: post.title,
        body: post.body,
        postToDiscord: "on",
      }),
    );

    expect(result?.message).toBe("A post to Discord is still in progress.");
    expect(postNewsToDiscord).not.toHaveBeenCalled();
  });

  it("can post again once an interrupted post has gone stale", async () => {
    const post = await existingPost({
      discordMessageId: newsDiscordPostingMark(Date.now() - 10 * 60_000),
    });

    const untouched = await updateNewsPost(
      {},
      form({ postId: post.id, title: post.title, body: post.body }),
    );
    expect(untouched?.message).toMatch(/earlier post to Discord was interrupted/);
    expect(postNewsToDiscord).not.toHaveBeenCalled();

    const retry = await updateNewsPost(
      {},
      form({
        postId: post.id,
        title: post.title,
        body: post.body,
        postToDiscord: "on",
      }),
    );
    expect(retry?.message).toBe("It's in Discord too.");
    expect(await storedCopy(post.id)).toBe(DISCORD_ID);
  });

  it("reports a post deleted before the edit landed", async () => {
    const result = await updateNewsPost(
      {},
      form({ postId: "gone-post", title: "T", body: "B" }),
    );
    expect(result?.error).toMatch(/not found/i);
  });
});

describe("the Discord copy follows the post's lifecycle", () => {
  it("deletes the Discord copy with the post", async () => {
    const post = await existingPost({ discordMessageId: DISCORD_ID });

    const result = await deleteNewsPost({}, form({ postId: post.id }));

    expect(result?.message).toBe("Post deleted, and its Discord copy with it.");
    expect(deleteNewsFromDiscord).toHaveBeenCalledWith(DISCORD_ID);
    expect(await prisma.newsPost.count()).toBe(0);
  });

  it("tells the admin when the Discord copy couldn't be removed", async () => {
    const post = await existingPost({ discordMessageId: DISCORD_ID });
    vi.mocked(deleteNewsFromDiscord).mockResolvedValueOnce(false);

    const result = await deleteNewsPost({}, form({ postId: post.id }));

    expect(result?.message).toMatch(/couldn't be removed.*by hand/);
    expect(await prisma.newsPost.count()).toBe(0);
  });

  it("an edit claims the post's Discord slot, so a rival's copy is never posted twice (seam)", async () => {
    const post = await existingPost();
    let fired = false;
    // Between this edit reading "no copy" and claiming the slot, another
    // admin's post to Discord lands and saves its message id.
    setRaceHook(
      onceAt("news.updateNewsPost.beforeDiscordClaim", async () => {
        fired = true;
        await prisma.newsPost.update({
          where: { id: post.id },
          data: { discordMessageId: "777" },
        });
      }),
    );

    const result = await updateNewsPost(
      {},
      form({
        postId: post.id,
        title: post.title,
        body: post.body,
        postToDiscord: "on",
      }),
    );

    expect(fired).toBe(true);
    expect(result?.message).toMatch(/wasn't posted again/);
    expect(postNewsToDiscord).not.toHaveBeenCalled();
    expect(await storedCopy(post.id)).toBe("777");
  });

  it("a post that lost its slot mid-send removes its own copy instead of overwriting", async () => {
    const post = await existingPost({
      discordMessageId: newsDiscordPostingMark(Date.now() - 10 * 60_000),
    });
    // While this request waits on Discord, another request takes over the
    // slot and saves its own copy's id.
    vi.mocked(postNewsToDiscord).mockImplementationOnce(async () => {
      await prisma.newsPost.update({
        where: { id: post.id },
        data: { discordMessageId: "999" },
      });
      return { ok: true, id: DISCORD_ID };
    });

    const result = await updateNewsPost(
      {},
      form({
        postId: post.id,
        title: post.title,
        body: post.body,
        postToDiscord: "on",
      }),
    );

    expect(result?.message).toMatch(/its Discord copy was removed/);
    expect(await storedCopy(post.id)).toBe("999");
    expect(deleteNewsFromDiscord).toHaveBeenCalledWith(DISCORD_ID);
  });

  it("a failed post only frees the slot it still holds", async () => {
    const post = await existingPost({
      discordMessageId: newsDiscordPostingMark(Date.now() - 10 * 60_000),
    });
    vi.mocked(postNewsToDiscord).mockImplementationOnce(async () => {
      await prisma.newsPost.update({
        where: { id: post.id },
        data: { discordMessageId: "999" },
      });
      return { ok: false, reason: "failed" };
    });

    await updateNewsPost(
      {},
      form({
        postId: post.id,
        title: post.title,
        body: post.body,
        postToDiscord: "on",
      }),
    );

    expect(await storedCopy(post.id)).toBe("999");
  });

  it("forgetting a gone copy never drops a newer one", async () => {
    const post = await existingPost({ discordMessageId: DISCORD_ID });
    vi.mocked(editNewsOnDiscord).mockImplementationOnce(async () => {
      await prisma.newsPost.update({
        where: { id: post.id },
        data: { discordMessageId: "888" },
      });
      return "gone";
    });

    await updateNewsPost(
      {},
      form({ postId: post.id, title: "Fixed", body: post.body }),
    );

    expect(await storedCopy(post.id)).toBe("888");
  });
});
