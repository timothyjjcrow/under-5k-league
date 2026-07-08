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

  function dismiss(id: number) {
    setToasts((t) => t.filter((x) => x.id !== id));
  }

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(92vw,22rem)] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cn(
            "toast-in pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm shadow-lg backdrop-blur",
            t.type === "error"
              ? "border-danger/40 bg-danger/15 text-danger"
              : t.type === "success"
                ? "border-success/40 bg-success/15 text-success"
                : "border-info/40 bg-info/15 text-info",
          )}
        >
          <ToastIcon type={t.type} />
          <span className="min-w-0 flex-1 pt-px text-fg">{t.message}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismiss(t.id)}
            className="-mr-1 shrink-0 rounded p-0.5 opacity-60 transition-opacity hover:opacity-100"
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}

function ToastIcon({ type }: { type: ToastType }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "mt-px shrink-0",
    "aria-hidden": true,
  };
  if (type === "success") {
    return (
      <svg {...common}>
        <circle cx={12} cy={12} r={9} />
        <path d="m8.5 12 2.5 2.5 4.5-5" />
      </svg>
    );
  }
  if (type === "error") {
    return (
      <svg {...common}>
        <circle cx={12} cy={12} r={9} />
        <path d="M12 8v5M12 16h.01" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx={12} cy={12} r={9} />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}
