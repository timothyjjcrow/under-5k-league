import { beforeEach, describe, expect, it, vi } from "vitest";

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
  sendDiscordMessage: vi.fn(async () => true),
}));

import { revalidatePath } from "next/cache";
import {
  createNewsPost,
  deleteNewsPost,
  toggleNewsPin,
} from "@/app/actions/news";
import { getSessionUser, requireAdmin } from "@/lib/auth";
import { sendDiscordMessage } from "@/lib/discord";
import { prisma } from "@/lib/prisma";
import { makeUser, ON_POSTGRES, raceN, sessionFor } from "./factories";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function createForm(requestId = REQUEST_ID): FormData {
  return form({
    requestId,
    title: "Week 3 moved",
    body: "Games are Thursday at 8 PM.",
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
  vi.mocked(sendDiscordMessage).mockReset();
  vi.mocked(sendDiscordMessage).mockResolvedValue(true);
  vi.mocked(revalidatePath).mockReset();
});

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
    ]);

    expect(results.every((result) => result?.error === "Not authorized")).toBe(
      true,
    );
    expect(await prisma.newsPost.count()).toBe(1);
    expect(
      (await prisma.newsPost.findUniqueOrThrow({ where: { id: post.id } }))
        .pinned,
    ).toBe(false);
    expect(sendDiscordMessage).not.toHaveBeenCalled();
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
    expect(sendDiscordMessage).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("creates once, awaits Discord, refreshes only news surfaces, and logs the actor", async () => {
    const result = await createNewsPost({}, createForm());

    expect(result?.error).toBeUndefined();
    expect(result?.message).toMatch(/live on the dashboard/i);
    const post = await prisma.newsPost.findFirstOrThrow();
    expect(post.title).toBe("Week 3 moved");
    expect(sendDiscordMessage).toHaveBeenCalledTimes(1);
    expect(sendDiscordMessage).toHaveBeenCalledWith(
      expect.stringContaining(`/news#${post.id}`),
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

  it("reports partial success when Discord delivery fails", async () => {
    vi.mocked(sendDiscordMessage).mockResolvedValueOnce(false);

    const result = await createNewsPost({}, createForm());

    expect(result?.error).toBeUndefined();
    expect(result?.message).toMatch(
      /Discord delivery couldn't be confirmed.*manually/i,
    );
    expect(await prisma.newsPost.count()).toBe(1);
    expect(await prisma.adminAction.count()).toBe(1);
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
    expect(sendDiscordMessage).toHaveBeenCalledTimes(1);
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
