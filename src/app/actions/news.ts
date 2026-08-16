"use server";

import { revalidatePath, updateTag } from "next/cache";
import { AUTOMATION_GATE_TAG } from "@/lib/automation-gate-constants";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { newsMediaHint, newsPostError } from "@/lib/news";
import { newsMessage, sendDiscordMessage } from "@/lib/discord";
import { str } from "@/lib/form";
import { logAdminAction } from "@/lib/admin-log";
import type { ActionResult } from "@/lib/action-result";

const NEWS_CREATE_REQUEST_PREFIX = "newsPostRequest:";

function refreshNewsSurfaces() {
  updateTag(AUTOMATION_GATE_TAG);
  revalidatePath("/");
  revalidatePath("/news");
  revalidatePath("/admin");
}

function validRecordId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

function createRequestKey(formData: FormData): string | null {
  const requestId = str(formData, "requestId").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    requestId,
  )
    ? `${NEWS_CREATE_REQUEST_PREFIX}${requestId}`
    : null;
}

export async function createNewsPost(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const title = str(formData, "title").trim();
  const body = str(formData, "body").trim();
  const error = newsPostError(title, body);
  if (error) return { error };
  const requestKey = createRequestKey(formData);
  if (!requestKey) {
    return {
      error:
        "This announcement form expired — reload the admin page and try again.",
    };
  }

  // The request marker and post commit together. A browser replay or
  // double-click races on Setting.key, so exactly one request creates the post
  // and sends/logs it. The marker deliberately survives post deletion: replaying
  // an old request must not resurrect an announcement an admin removed.
  const alreadySubmitted = await prisma.setting.findUnique({
    where: { key: requestKey },
  });
  if (alreadySubmitted) {
    refreshNewsSurfaces();
    return { message: "Already posted — this submission was received once." };
  }
  let post: { id: string };
  try {
    post = await prisma.$transaction(async (tx) => {
      await tx.setting.create({ data: { key: requestKey, value: "pending" } });
      const created = await tx.newsPost.create({
        data: { title, body, authorId: admin.id },
        select: { id: true },
      });
      await tx.setting.update({
        where: { key: requestKey },
        data: { value: created.id },
      });
      return created;
    });
  } catch (transactionError) {
    if ((transactionError as { code?: string }).code === "P2002") {
      refreshNewsSurfaces();
      return { message: "Already posted — this submission was received once." };
    }
    throw transactionError;
  }

  refreshNewsSurfaces();
  // Await the bounded best-effort sender so the administrator learns when the
  // site post succeeded but Discord delivery did not. Deep-link to the new
  // post so readers land on it, not the top of the archive.
  const discordSent = await sendDiscordMessage(
    newsMessage(title, body, post.id),
  );
  // Discord persistence happens after the first surface refresh. Expire again
  // immediately so a later, non-essential audit-log failure cannot leave a
  // gate filled during the network call hiding the new outbox row.
  updateTag(AUTOMATION_GATE_TAG);
  await logAdminAction({
    action: "createNewsPost",
    summary: `Published news post "${title}"`,
  });

  const siteMessage =
    newsMediaHint(body) ?? "Posted — it's live on the dashboard";
  return {
    message: discordSent
      ? siteMessage
      : `${siteMessage} — but Discord delivery couldn't be confirmed. Check the channel and post it manually if it's missing.`,
  };
}

export async function toggleNewsPin(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const id = str(formData, "postId").trim();
  if (!validRecordId(id)) return { error: "Invalid post request" };
  const desired = str(formData, "pinned");
  if (desired !== "true" && desired !== "false") {
    return {
      error: "Invalid pin request — reload the admin page and try again.",
    };
  }
  const pinned = desired === "true";
  const post = await prisma.newsPost.findUnique({ where: { id } });
  if (!post) {
    refreshNewsSurfaces();
    return { error: "Post not found" };
  }
  if (post.pinned === pinned) {
    refreshNewsSurfaces();
    return {
      message: pinned ? "Already pinned to the top" : "Already unpinned",
    };
  }
  const changed = await prisma.newsPost.updateMany({
    where: { id, pinned: !pinned },
    data: { pinned },
  });
  if (changed.count === 0) {
    const current = await prisma.newsPost.findUnique({ where: { id } });
    if (!current) {
      refreshNewsSurfaces();
      return { error: "Post not found" };
    }
    if (current.pinned === pinned) {
      refreshNewsSurfaces();
      return {
        message: pinned ? "Already pinned to the top" : "Already unpinned",
      };
    }
    refreshNewsSurfaces();
    return {
      error: "The post changed while you were updating it — try again.",
    };
  }
  refreshNewsSurfaces();
  await logAdminAction({
    action: "toggleNewsPin",
    summary: `${pinned ? "Pinned" : "Unpinned"} news post "${post.title}"`,
  });
  return { message: pinned ? "Pinned to the top" : "Unpinned" };
}

export async function deleteNewsPost(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const id = str(formData, "postId").trim();
  if (!validRecordId(id)) return { error: "Invalid post request" };
  const post = await prisma.newsPost.findUnique({ where: { id } });
  if (!post) {
    refreshNewsSurfaces();
    return { message: "Already deleted" };
  }
  const deleted = await prisma.newsPost.deleteMany({ where: { id } });
  if (deleted.count === 0) {
    refreshNewsSurfaces();
    return { message: "Already deleted" };
  }
  refreshNewsSurfaces();
  await logAdminAction({
    action: "deleteNewsPost",
    summary: `Deleted news post "${post.title}"`,
  });
  return { message: "Post deleted" };
}
