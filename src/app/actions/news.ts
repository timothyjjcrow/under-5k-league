"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import {
  newsDiscordCopy,
  newsDiscordPostingMark,
  newsMediaHint,
  newsPostError,
} from "@/lib/news";
import {
  deleteNewsFromDiscord,
  editNewsOnDiscord,
  newsMessage,
  postNewsToDiscord,
} from "@/lib/discord";
import { bool, str } from "@/lib/form";
import { raceHook } from "@/lib/race-hook";
import { logAdminAction } from "@/lib/admin-log";
import type { ActionResult } from "@/lib/action-result";
import { isUniqueViolation } from "@/lib/prisma-errors";

const NEWS_CREATE_REQUEST_PREFIX = "newsPostRequest:";

function refreshNewsSurfaces() {
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

type DiscordPostOutcome = "posted" | "no-webhook" | "failed" | "deleted";

/**
 * Post a news post's Discord copy under the "posting" mark this request has
 * already claimed, then swap the mark for the message id. Both follow-up
 * writes re-assert the mark: if it changed while Discord answered (the post
 * was deleted, or another request took over an interrupted post), this copy
 * is not ours to track, so it is removed again instead of overwriting theirs.
 */
async function postCopyToDiscord(
  postId: string,
  mark: string,
  title: string,
  body: string,
  pingEveryone: boolean,
): Promise<DiscordPostOutcome> {
  const sent = await postNewsToDiscord(
    newsMessage(title, body, postId),
    pingEveryone,
  );
  if (sent.ok) {
    const saved = await prisma.newsPost.updateMany({
      where: { id: postId, discordMessageId: mark },
      data: { discordMessageId: sent.id },
    });
    if (saved.count === 0) {
      await deleteNewsFromDiscord(sent.id);
      return "deleted";
    }
    return "posted";
  }
  await prisma.newsPost.updateMany({
    where: { id: postId, discordMessageId: mark },
    data: { discordMessageId: null },
  });
  return sent.reason;
}

function discordPostSentence(
  outcome: DiscordPostOutcome | null,
  pingEveryone: boolean,
): string {
  switch (outcome) {
    case null:
      return "It wasn't posted to Discord.";
    case "posted":
      return pingEveryone
        ? "It's in Discord too, with an @everyone ping."
        : "It's in Discord too.";
    case "no-webhook":
      return "No Discord webhook is set, so it wasn't posted there.";
    case "deleted":
      return "It was deleted while it was being posted, so its Discord copy was removed.";
    case "failed":
      return "Discord delivery couldn't be confirmed. Check the channel, and if it's missing, use Edit to post it again.";
  }
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
  const postToDiscord = bool(formData, "postToDiscord");
  const pingEveryone = postToDiscord && bool(formData, "pingEveryone");
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
  // an old request must not resurrect an announcement an admin removed. A post
  // bound for Discord is born holding the "posting" mark, so the edit form
  // can't start a second Discord post while this one is in flight.
  const alreadySubmitted = await prisma.setting.findUnique({
    where: { key: requestKey },
  });
  if (alreadySubmitted) {
    refreshNewsSurfaces();
    return { message: "Already posted — this submission was received once." };
  }
  const mark = postToDiscord ? newsDiscordPostingMark(Date.now()) : null;
  let post: { id: string };
  try {
    post = await prisma.$transaction(async (tx) => {
      await tx.setting.create({ data: { key: requestKey, value: "pending" } });
      const created = await tx.newsPost.create({
        data: { title, body, authorId: admin.id, discordMessageId: mark },
        select: { id: true },
      });
      await tx.setting.update({
        where: { key: requestKey },
        data: { value: created.id },
      });
      return created;
    });
  } catch (transactionError) {
    if (isUniqueViolation(transactionError)) {
      refreshNewsSurfaces();
      return { message: "Already posted — this submission was received once." };
    }
    throw transactionError;
  }

  refreshNewsSurfaces();
  // Await the bounded post so the administrator learns when the site post
  // succeeded but Discord delivery did not. The message deep-links to the new
  // post so readers land on it, not the top of the archive.
  const outcome = mark
    ? await postCopyToDiscord(post.id, mark, title, body, pingEveryone)
    : null;
  await logAdminAction({
    action: "createNewsPost",
    summary: `Published news post "${title}"${
      outcome === "posted"
        ? pingEveryone
          ? " (posted to Discord with @everyone)"
          : " (posted to Discord)"
        : " (site only)"
    }`,
  });

  const siteMessage =
    newsMediaHint(body) ?? "Posted — it's live on the dashboard.";
  return {
    message: `${siteMessage} ${discordPostSentence(outcome, pingEveryone)}`,
  };
}

/**
 * Fix a post in place: the site updates, and a Discord copy made by this site
 * is rewritten rather than posted again. A post with no Discord copy (posted
 * before edits could reach Discord, left off Discord, or a failed post) can
 * be sent there from here when the admin ticks the box.
 */
export async function updateNewsPost(
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
  const title = str(formData, "title").trim();
  const body = str(formData, "body").trim();
  const error = newsPostError(title, body);
  if (error) return { error };
  const postToDiscord = bool(formData, "postToDiscord");
  const pingEveryone = postToDiscord && bool(formData, "pingEveryone");

  const before = await prisma.newsPost.findUnique({ where: { id } });
  if (!before) {
    refreshNewsSurfaces();
    return { error: "Post not found — it may have been deleted." };
  }
  const textChanged = before.title !== title || before.body !== body;
  if (textChanged) {
    const saved = await prisma.newsPost.updateMany({
      where: { id },
      data: { title, body },
    });
    if (saved.count === 0) {
      refreshNewsSurfaces();
      return { error: "Post not found — it may have been deleted." };
    }
  }
  // Re-read so the Discord copy carries what is stored now, even if another
  // admin saved an edit a moment ago.
  const post = textChanged
    ? await prisma.newsPost.findUnique({ where: { id } })
    : before;
  if (!post) {
    refreshNewsSurfaces();
    return { error: "Post not found — it may have been deleted." };
  }

  const copy = newsDiscordCopy(post.discordMessageId, Date.now());
  let discordSentence = "";
  let postedNow = false;
  if (copy.state === "posted") {
    // Rewritten on every save, changed text or not, so saving again is also
    // how an admin retries an edit Discord refused.
    const edited = await editNewsOnDiscord(
      copy.messageId,
      newsMessage(post.title, post.body, post.id),
    );
    if (edited === "ok") {
      discordSentence = textChanged
        ? "The Discord copy was updated too."
        : "The Discord copy was refreshed to match.";
    } else if (edited === "gone") {
      // Deleted in the channel, or the webhook changed: stop tracking it,
      // unless another request already tracks a newer copy.
      await prisma.newsPost.updateMany({
        where: { id, discordMessageId: copy.messageId },
        data: { discordMessageId: null },
      });
      discordSentence =
        "Its Discord copy is gone (deleted in the channel, or the webhook changed), so only the site changed.";
    } else if (edited === "no-webhook") {
      discordSentence =
        "No Discord webhook is set, so the Discord copy wasn't changed.";
    } else {
      discordSentence =
        "Discord didn't take the edit, so the Discord copy still shows the old text. Save again to retry.";
    }
  } else if (copy.state === "posting" && !copy.interrupted) {
    discordSentence = textChanged
      ? "A post to Discord is still in progress with the earlier text. Save again in a minute to update it."
      : "A post to Discord is still in progress.";
  } else if (postToDiscord) {
    // No copy, or one a dead request left half-posted. Claim the exact value
    // read above, so only one request posts it.
    await raceHook("news.updateNewsPost.beforeDiscordClaim");
    const mark = newsDiscordPostingMark(Date.now());
    const claimed = await prisma.newsPost.updateMany({
      where: { id, discordMessageId: post.discordMessageId },
      data: { discordMessageId: mark },
    });
    if (claimed.count === 0) {
      discordSentence =
        "It changed on Discord while you were saving, so it wasn't posted again. Reload to see it.";
    } else {
      const outcome = await postCopyToDiscord(
        id,
        mark,
        post.title,
        post.body,
        pingEveryone,
      );
      postedNow = outcome === "posted";
      discordSentence = discordPostSentence(outcome, pingEveryone);
    }
  } else if (copy.state === "posting") {
    discordSentence =
      "An earlier post to Discord was interrupted. Check the channel; if it isn't there, tick “Also post to Discord” and save again.";
  }

  refreshNewsSurfaces();
  if (!textChanged && !postedNow) {
    return { message: discordSentence || "Nothing changed." };
  }
  await logAdminAction({
    action: "updateNewsPost",
    summary: textChanged
      ? `Edited news post "${post.title}"${
          before.title !== post.title ? ` (was "${before.title}")` : ""
        }${postedNow ? " and posted it to Discord" : ""}`
      : `Posted news post "${post.title}" to Discord`,
  });
  const siteMessage = textChanged
    ? (newsMediaHint(post.body, "Saved") ?? "Saved.")
    : "";
  return {
    message: [siteMessage, discordSentence].filter(Boolean).join(" "),
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
  // Best-effort: the post is gone from the site either way. A post still
  // being posted removes its own Discord copy when it lands (postCopyToDiscord).
  const copy = newsDiscordCopy(post.discordMessageId, Date.now());
  const removed =
    copy.state === "posted" ? await deleteNewsFromDiscord(copy.messageId) : null;
  await logAdminAction({
    action: "deleteNewsPost",
    summary: `Deleted news post "${post.title}"${
      removed ? " and its Discord copy" : ""
    }`,
  });
  if (removed === true) {
    return { message: "Post deleted, and its Discord copy with it." };
  }
  if (removed === false) {
    return {
      message:
        "Post deleted, but its Discord copy couldn't be removed. Delete it in the channel by hand.",
    };
  }
  if (copy.state === "posting" && copy.interrupted) {
    return {
      message:
        "Post deleted. An earlier post to Discord was interrupted, so check the channel and delete any copy by hand.",
    };
  }
  return { message: "Post deleted" };
}
