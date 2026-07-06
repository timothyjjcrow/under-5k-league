"use client";

import { buttonClasses } from "@/components/ui";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-md space-y-4 py-16 text-center">
      <h1 className="text-2xl font-bold">Something went wrong</h1>
      <p className="text-sm text-muted">
        {error.message || "An unexpected error occurred."}
      </p>
      <button onClick={reset} className={buttonClasses("primary")}>
        Try again
      </button>
    </div>
  );
}
