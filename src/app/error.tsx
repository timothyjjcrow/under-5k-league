"use client";

import Link from "next/link";
import { Card, CardBody, buttonClasses } from "@/components/ui";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-md py-16">
      <Card>
        <CardBody className="flex flex-col items-center gap-4 py-10 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-xl bg-danger/15 text-2xl font-bold text-danger">
            !
          </div>
          <div>
            <div className="text-xl font-bold">Something went wrong</div>
            <p className="mt-1 text-sm text-muted">
              {error.message || "An unexpected error occurred."}
            </p>
            {error.digest ? (
              <p className="mt-1 font-mono text-[11px] text-muted/70">
                ref: {error.digest}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <button onClick={reset} className={buttonClasses("primary")}>
              Try again
            </button>
            <Link href="/" className={buttonClasses("secondary")}>
              Back to home
            </Link>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
