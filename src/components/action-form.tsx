"use client";

import * as React from "react";
import {
  createContext,
  startTransition,
  useActionState,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from "react";
import { useFormStatus } from "react-dom";
import { pushToast } from "./toaster";
import { buttonClasses, type ButtonVariant, type ButtonSize } from "./ui";
import type { ActionResult } from "@/lib/action-result";

export type { ActionResult };

// ActionForm dispatches manually (see onSubmit below), which bypasses the
// native form-action flow — useFormStatus() can't see pending anymore, so the
// form provides useActionState's isPending via context for SubmitButton.
const PendingContext = createContext(false);

/**
 * A <form> bound to a server action that returns an ActionResult. Results are
 * surfaced as toasts so mutations never crash the page and always give feedback.
 *
 * Two hardenings every call site inherits:
 * - Typed input survives an { error } result. React 19 auto-resets
 *   uncontrolled fields after ANY completed <form action> — including
 *   validation bounces, which wiped the long /me questionnaire. Capturing
 *   FormData ourselves and dispatching inside a transition opts out; fields
 *   are reset only on success (preserving the old clear-on-success behavior).
 * - A REJECTED action promise (network drop, server restart mid-deploy)
 *   becomes an error toast instead of propagating to the root error.tsx and
 *   replacing the whole page. No action here calls redirect(), so nothing
 *   legitimate is swallowed.
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
  const safeAction = useCallback(
    async (prev: ActionResult, fd: FormData): Promise<ActionResult> => {
      try {
        return await action(prev, fd);
      } catch {
        return {
          error:
            "Couldn't reach the server — nothing was saved. Check your connection and try again.",
        };
      }
    },
    [action],
  );
  const [state, formAction, isPending] = useActionState(safeAction, null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!state) return;
    if (state.error) {
      pushToast("error", state.error);
    } else {
      if (state.message) pushToast("success", state.message);
      // Success: clear the form (manual dispatch skipped React's auto-reset).
      formRef.current?.reset();
    }
  }, [state]);

  return (
    <form
      ref={formRef}
      // Kept as the no-JS / pre-hydration fallback path.
      action={formAction}
      onSubmit={(e) => {
        e.preventDefault();
        // Capture synchronously (the form may re-render mid-transition) and
        // include the submitter so button name/value pairs keep working.
        const fd = new FormData(
          e.currentTarget,
          (e.nativeEvent as SubmitEvent).submitter,
        );
        startTransition(() => formAction(fd));
      }}
      className={className}
    >
      <PendingContext.Provider value={isPending}>
        {hidden
          ? Object.entries(hidden).map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))
          : null}
        {children}
      </PendingContext.Provider>
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
  "aria-pressed": ariaPressed,
}: {
  children: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  confirm?: string;
  disabled?: boolean;
  /** Toggle-state pass-through for pick-one button groups (e.g. pick'em). */
  "aria-pressed"?: boolean;
}) {
  // Context covers ActionForm's manual dispatch; useFormStatus still covers
  // any SubmitButton rendered inside a plain <form action={…}>.
  const ctxPending = useContext(PendingContext);
  const { pending: nativePending } = useFormStatus();
  const pending = ctxPending || nativePending;
  return (
    <button
      type="submit"
      aria-pressed={ariaPressed}
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
