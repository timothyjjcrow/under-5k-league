"use client";

import * as React from "react";
import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { pushToast } from "./toaster";
import { buttonClasses, type ButtonVariant, type ButtonSize } from "./ui";
import type { ActionResult } from "@/lib/action-result";

export type { ActionResult };

/**
 * A <form> bound to a server action that returns an ActionResult. Results are
 * surfaced as toasts so mutations never crash the page and always give feedback.
 */
export function ActionForm({
  action,
  children,
  className,
  hidden,
}: {
  action: (prev: ActionResult, fd: FormData) => Promise<ActionResult>;
  children: React.ReactNode;
  className?: string;
  hidden?: Record<string, string>;
}) {
  const [state, formAction] = useActionState(action, null);
  useEffect(() => {
    if (state?.error) pushToast("error", state.error);
    else if (state?.message) pushToast("success", state.message);
  }, [state]);

  return (
    <form action={formAction} className={className}>
      {hidden
        ? Object.entries(hidden).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))
        : null}
      {children}
    </form>
  );
}

/** Submit button that shows a pending state and can require confirmation. */
export function SubmitButton({
  children,
  variant = "primary",
  size = "md",
  className,
  confirm,
  disabled,
}: {
  children: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  confirm?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      onClick={
        confirm
          ? (e) => {
              if (!window.confirm(confirm)) e.preventDefault();
            }
          : undefined
      }
      className={buttonClasses(variant, size, className)}
    >
      {pending ? (
        <>
          <span
            aria-hidden
            className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current/30 border-t-current"
          />
          Working…
        </>
      ) : (
        children
      )}
    </button>
  );
}
