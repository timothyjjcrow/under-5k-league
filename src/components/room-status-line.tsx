import Link from "next/link";
import { buttonClasses } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { RoomStatus } from "@/lib/room-status";

const TONE_CLASSES: Record<RoomStatus["tone"], string> = {
  danger: "border-danger/40 bg-danger/10 text-danger",
  warning: "border-warning/40 bg-warning/10 text-warning",
  info: "border-info/40 bg-info/10 text-info",
};

/**
 * The live rooms' single status line (draft and inhouse): the one condition
 * `roomStatus` picked, or nothing. Keyed by kind so a change of condition
 * mounts a fresh live region and is announced, rather than silently
 * rewriting the old one. An expired sign-in is an alert with the way back;
 * everything else is a polite status.
 */
export function RoomStatusLine({
  status,
  signInHref,
}: {
  status: RoomStatus | null;
  /** Where "Sign in again" goes when the sign-in expired. */
  signInHref?: string;
}) {
  if (!status) return null;
  const signedOut = status.kind === "signed-out";
  return (
    <div
      key={status.kind}
      role={signedOut ? "alert" : "status"}
      aria-live={signedOut ? undefined : "polite"}
      className={cn(
        "rounded-lg border px-4 py-2 text-sm",
        TONE_CLASSES[status.tone],
        signedOut && "flex flex-wrap items-center justify-between gap-3",
      )}
    >
      <span>{status.text}</span>
      {signedOut && signInHref ? (
        <Link href={signInHref} className={buttonClasses("secondary", "sm")}>
          Sign in again
        </Link>
      ) : null}
    </div>
  );
}
