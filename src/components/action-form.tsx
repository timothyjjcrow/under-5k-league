"use client";

import * as React from "react";
import {
  createContext,
  startTransition,
  useActionState,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useFormStatus } from "react-dom";
import { pushToast } from "./toaster";
import { buttonClasses, type ButtonVariant, type ButtonSize } from "./ui";
import type { ActionResult } from "@/lib/action-result";

export type { ActionResult };

// ActionForm dispatches manually (see onSubmit below), which bypasses the
// native form-action flow — useFormStatus() can't see pending anymore, so the
// form provides useActionState's isPending via context for SubmitButton.
// Exported so DangerSubmit (a separate client component, rendered inside the
// same <ActionForm>) can show the same pending state as SubmitButton.
export const PendingContext = createContext(false);
export const FormChangeContext = createContext<() => void>(() => {});

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
  trackChanges = false,
}: {
  action: (prev: ActionResult, fd: FormData) => Promise<ActionResult>;
  children: React.ReactNode;
  className?: string;
  hidden?: Record<string, string>;
  trackChanges?: boolean;
}) {
  const safeAction = useCallback(
    async (prev: ActionResult, fd: FormData): Promise<ActionResult> => {
      let result: ActionResult;
      try {
        result = await action(prev, fd);
      } catch {
        result = {
          error:
            "The connection ended before we could confirm the result. The action may have completed — check the current page state before trying again.",
        };
      }
      // Emit feedback from the promise continuation, not a state effect. A
      // successful server action can revalidate away the form that submitted
      // it (accepting a reschedule removes the pending-response form); an
      // unmounted form never runs its effect and used to lose the confirmation
      // even though the database commit succeeded. The global Toaster remains
      // mounted, so dispatching here survives that RSC replacement.
      if (result?.error) {
        pushToast("error", result.error);
      } else if (result?.message) {
        pushToast("success", result.message);
      }
      return result;
    },
    [action],
  );
  const [state, formAction, isPending] = useActionState(safeAction, null);
  const formRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const errorId = useId();
  const [dirty, setDirty] = useState(false);
  const markDirty = useCallback(() => {
    if (trackChanges) setDirty(true);
  }, [trackChanges]);

  useEffect(() => {
    if (state?.error) errorRef.current?.focus();
  }, [state]);

  useEffect(() => {
    if (!state || state.error) return;
    // Success: clear the form (manual dispatch skipped React's auto-reset).
    formRef.current?.reset();
  }, [state]);

  return (
    <form
      ref={formRef}
      // Kept as the no-JS / pre-hydration fallback path.
      action={formAction}
      aria-describedby={state?.error ? errorId : undefined}
      onChange={(event) => {
        if (event.target instanceof HTMLElement && event.target.getAttribute("name")) markDirty();
      }}
      onReset={trackChanges ? () => setDirty(false) : undefined}
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
        <FormChangeContext.Provider value={markDirty}>
          {hidden
            ? Object.entries(hidden).map(([k, v]) => (
                <input key={k} type="hidden" name={k} value={v} />
              ))
            : null}
          {children}
          {state?.error ? (
            <p
              ref={errorRef}
              id={errorId}
              tabIndex={-1}
              className="basis-full w-full col-span-full scroll-mt-40 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-danger focus:outline-none focus:ring-2 focus:ring-danger/50"
            >
              {state.error}
            </p>
          ) : null}
          {trackChanges ? (
            <p
              role="status"
              className="basis-full col-span-full text-xs text-muted"
            >
              {isPending
                ? "Saving…"
                : dirty
                  ? "Unsaved changes"
                  : state && !state.error
                    ? "Saved"
                    : "Changes are saved when you submit this form."}
            </p>
          ) : null}
        </FormChangeContext.Provider>
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
  name,
  value,
  formNoValidate,
  "aria-pressed": ariaPressed,
}: {
  children: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  confirm?: string;
  disabled?: boolean;
  name?: string;
  value?: string;
  formNoValidate?: boolean;
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
      name={name}
      value={value}
      formNoValidate={formNoValidate}
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
            className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current/30 border-t-current motion-reduce:animate-none"
          />
          Working…
        </>
      ) : (
        children
      )}
    </button>
  );
}
