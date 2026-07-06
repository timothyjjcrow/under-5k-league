import { NextRequest, NextResponse } from "next/server";
import { destroySession } from "@/lib/auth";

async function handle(req: NextRequest) {
  await destroySession();
  return NextResponse.redirect(new URL("/", req.url));
}

export const GET = handle;
export const POST = handle;
