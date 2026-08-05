import { NextResponse } from "next/server";
import { revalidatePath, revalidateTag } from "next/cache";
import { runAutomation } from "@/lib/automation-service";
import { validCronBearer } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const NO_STORE = { "cache-control": "no-store" };

export async function GET(request: Request) {
  if (
    !validCronBearer(
      request.headers.get("authorization"),
      process.env.CRON_SECRET,
    )
  ) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401, headers: NO_STORE },
    );
  }

  try {
    const result = await runAutomation({ source: "CRON", signal: request.signal });
    if (result.kind === "lease-held") {
      return NextResponse.json(
        {
          ok: true,
          status: result.status,
          skipped: "LEASE_HELD",
          retryAfterSeconds: result.retryAfterSeconds,
        },
        {
          status: 202,
          headers: {
            ...NO_STORE,
            "retry-after": String(result.retryAfterSeconds),
          },
        },
      );
    }

    if (result.imported > 0) {
      revalidateTag("games", { expire: 0 });
      revalidatePath("/", "layout");
    }

    if (result.kind === "fenced") {
      return NextResponse.json(
        { ok: true, status: "FENCED" },
        { status: 202, headers: NO_STORE },
      );
    }

    const body = {
      ok: result.status === "SUCCEEDED",
      status: result.status,
      durationMs: result.durationMs,
      recoveredExpiredLease: result.recoveredExpiredLease,
      errorCode: result.errorCode,
    };
    return NextResponse.json(body, {
      // Vercel does not retry cron failures, but a non-2xx is still essential:
      // it makes degraded/failed passes visible in platform observability while
      // the next scheduled invocation and persisted state own recovery.
      status: result.status === "SUCCEEDED" ? 200 : 500,
      headers: NO_STORE,
    });
  } catch {
    // The database may be unavailable before a lease can be acquired or while
    // health is being finalized. Keep details in server logs/observability;
    // this machine boundary returns no exception text or configuration data.
    return NextResponse.json(
      { ok: false, status: "UNAVAILABLE" },
      { status: 503, headers: NO_STORE },
    );
  }
}
