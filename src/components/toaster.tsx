"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type ToastType = "success" | "error" | "info";
type Toast = { id: number; type: ToastType; message: string };

let counter = 0;

/** Fire a toast from anywhere on the client (including ActionForm results). */
export function pushToast(type: ToastType, message: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("ld2l-toast", { detail: { type, message } }),
  );
}

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    function onToast(e: Event) {
      const { type, message } = (e as CustomEvent).detail as {
        type: ToastType;
        message: string;
      };
      const id = ++counter;
      setToasts((t) => [...t, { id, type, message }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
    }
    window.addEventListener("ld2l-toast", onToast);
    return () => window.removeEventListener("ld2l-toast", onToast);
  }, []);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(92vw,22rem)] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "pointer-events-auto rounded-lg border px-4 py-2.5 text-sm shadow-lg",
            t.type === "error"
              ? "border-danger/40 bg-danger/15 text-danger"
              : t.type === "success"
                ? "border-success/40 bg-success/15 text-success"
                : "border-line bg-surface-2 text-fg",
          )}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
