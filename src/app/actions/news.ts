"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { newsPostError } from "@/lib/news";
import { newsMessage, sendDiscordMessage } from "@/lib/discord";
import { str } from "@/lib/form";
import type { ActionResult } from "@/lib/action-result";

function refresh() {
  revalidatePath("/", "layout");
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

  await prisma.newsPost.create({
    data: { title, body, authorId: admin.id },
  });
  refresh();
  // Best-effort — a dead webhook must never block the post.
  void sendDiscordMessage(newsMessage(title, body));
  return { message: "Posted — it's live on the dashboard" };
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
  const id = str(formData, "postId");
  const post = await prisma.newsPost.findUnique({ where: { id } });
  if (!post) return { error: "Post not found" };
  await prisma.newsPost.update({
    where: { id },
    data: { pinned: !post.pinned },
  });
  refresh();
  return { message: post.pinned ? "Unpinned" : "Pinned to the top" };
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
  const id = str(formData, "postId");
  const post = await prisma.newsPost.findUnique({ where: { id } });
  if (!post) return { error: "Post not found" };
  await prisma.newsPost.delete({ where: { id } });
  refresh();
  return { message: "Post deleted" };
}
