"use client";

import * as React from "react";
import { useContext, useEffect, useId, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { buttonClasses, type ButtonSize } from "./ui";
import { PendingContext } from "./action-form";

/**
 * Submit button for the handful of actions that CANNOT be undone.
 *
 * Every other barrier on /admin is `window.confirm`, which is one Enter
 * keypress away from happening — the OK button is focused by default, and the
 * dialog looks identical whether it is guarding "Rename team" or "permanently
 * delete this season and every game in it". That is the right barrier for a
 * reversible action and the wrong one for a season-ending one: it makes the
 * two indistinguishable at the exact moment the difference matters.
 *
 * This asks the admin to TYPE something only someone who meant it would type —
 * the season name, the team name — which cannot be satisfied by a reflex. Use
 * it ONLY where recovery is genuinely impossible from inside the app; using it
 * for routine actions would rebuild the same fatigue it exists to break.
 *
 * It also states the CONSEQUENCES as a list rather than a paragraph, because
 * the thing an admin needs to read is what dies, and a native confirm renders
 * one wall of text that gets skimmed.
 */
export function DangerSubmit({
  children,
  size = "sm",
  className,
  /** Exact string the admin must type. Use a real name, never "DELETE". */
  token,
  /** Short sentence: what is about to happen. */
  title,
  /** One line per thing that is destroyed. Be specific; include counts. */
  consequences,
  /** Optional: what CAN be recovered afterwards, so the note is honest. */
  recovery,
  evidence,
  disabled,
}: {
  children: React.ReactNode;
  size?: ButtonSize;
  className?: string;
  token: string;
  title: string;
  consequences: string[];
  recovery?: string;
  /** Additional operator evidence required before the destructive submit. */
  evidence?: {
    name: string;
    label: string;
    description?: string;
    placeholder?: string;
  };
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [evidenceValue, setEvidenceValue] = useState("");
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef(false);
  const ctxPending = useContext(PendingContext);
  const { pending: nativePending } = useFormStatus();
  const pending = ctxPending || nativePending;
  // Trim only — matching is otherwise EXACT, including case. A token the admin
  // has to reproduce exactly is the whole mechanism; a fuzzy match would let a
  // half-read team name through.
  const armed =
    typed.trim() === token.trim() &&
    (!evidence || evidenceValue.trim().length > 0);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      return;
    }
    // A submitted action can leave the trigger disabled while it is pending;
    // wait until it is focusable again rather than dropping focus onto <body>.
    if (returnFocusRef.current && !pending) {
      returnFocusRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open, pending]);

  const closeDialog = () => {
    returnFocusRef.current = true;
    setOpen(false);
    setTyped("");
    setEvidenceValue("");
  };

  // Keep keyboard focus inside the modal. aria-modal tells assistive technology
  // the background is inactive; this makes the same promise true for Tab/Shift
  // +Tab users and returns focus to the destructive-action trigger on close.
  const onDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeDialog();
      return;
    }
    if (e.key !== "Tab") return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) {
      e.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !dialog.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={pending || disabled}
        onClick={() => {
          setTyped("");
          setEvidenceValue("");
          returnFocusRef.current = false;
          setOpen(true);
        }}
        className={buttonClasses("danger", size, className)}
      >
        {pending ? "Working…" : children}
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${inputId}-title`}
            aria-describedby={`${inputId}-description`}
            tabIndex={-1}
            onKeyDown={onDialogKeyDown}
            className="max-h-full w-full max-w-lg overflow-y-auto rounded-xl border border-danger/40 bg-surface p-5 shadow-xl"
          >
            <h2
              id={`${inputId}-title`}
              className="text-lg font-semibold text-danger"
            >
              {title}
            </h2>
            <div id={`${inputId}-description`}>
              <ul className="mt-3 space-y-1 text-sm text-fg">
                {consequences.map((c) => (
                  <li key={c} className="flex gap-2">
                    <span aria-hidden className="text-danger">
                      •
                    </span>
                    <span className="min-w-0">{c}</span>
                  </li>
                ))}
              </ul>
              {recovery ? (
                <p className="mt-3 rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-xs text-muted">
                  {recovery}
                </p>
              ) : null}
            </div>
            {evidence ? (
              <div className="mt-4">
                <label
                  htmlFor={`${inputId}-evidence`}
                  className="block text-sm text-muted"
                >
                  {evidence.label}
                </label>
                {evidence.description ? (
                  <p className="mt-1 text-xs text-muted">
                    {evidence.description}
                  </p>
                ) : null}
                <textarea
                  id={`${inputId}-evidence`}
                  name={evidence.name}
                  value={evidenceValue}
                  onChange={(event) => setEvidenceValue(event.target.value)}
                  placeholder={evidence.placeholder}
                  required
                  rows={3}
                  autoComplete="off"
                  spellCheck={false}
                  className="mt-2 w-full resize-y rounded-lg border border-line bg-surface-2/50 px-3 py-2 font-mono text-xs outline-none focus:border-danger/60 focus-visible:ring-2 focus-visible:ring-danger/40"
                />
              </div>
            ) : null}
            <label htmlFor={inputId} className="mt-4 block text-sm text-muted">
              Type <b className="text-fg">{token}</b> to confirm:
            </label>
            <input
              id={inputId}
              ref={inputRef}
              // The server must verify the same token. A client-only disabled
              // button is useful UX, not authorization: direct POSTs and
              // modified markup never pass through `armed`.
              name="confirmationName"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              // Enter must not submit the enclosing form from here — the whole
              // point is that no single keypress can complete this.
              onKeyDown={(e) => {
                if (e.key === "Enter") e.preventDefault();
              }}
              autoComplete="off"
              spellCheck={false}
              className="mt-1 h-10 w-full rounded-lg border border-line bg-surface-2/50 px-3 text-sm outline-none focus:border-danger/60 focus-visible:ring-2 focus-visible:ring-danger/40"
            />
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={closeDialog}
                className={buttonClasses("secondary", "md")}
              >
                Cancel
              </button>
              {/* The ONLY submit in this component. It stays disabled until the
                  token matches, so the destructive dispatch is unreachable
                  until the admin has typed the name out. */}
              <button
                type="submit"
                disabled={!armed || pending}
                onClick={(e) => {
                  // Dispatch while the submitter is still mounted. Closing the
                  // dialog first removes the button before Chrome's default
                  // submit behavior runs, so ActionForm never sees onSubmit.
                  e.preventDefault();
                  const form = e.currentTarget.form;
                  if (!form) return;
                  returnFocusRef.current = true;
                  form.requestSubmit(e.currentTarget);
                  setOpen(false);
                  setTyped("");
                  setEvidenceValue("");
                }}
                className={buttonClasses("danger", "md")}
              >
                {children}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
