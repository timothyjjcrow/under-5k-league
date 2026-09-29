"use client";

import { createContext, useContext, type ReactNode } from "react";
import { SubmitButton } from "@/components/action-form";
import type { ButtonSize } from "@/components/ui";

// The Start-draft button's confirm is built on the server (seat math, Discord
// reach), but one line of it can only be known where the button is shown:
// which captains are in the draft room. The room knows that live from its
// poll; /admin knows it as of page load. Either wraps the button in
// StartDraftConfirmLine, and the button adds that line to the end of its
// confirm when clicked.

const ConfirmLine = createContext("");

/** Appends `line` to the confirm of any Start draft button inside it. */
export function StartDraftConfirmLine({
  line,
  children,
}: {
  line: string;
  children: ReactNode;
}) {
  return <ConfirmLine.Provider value={line}>{children}</ConfirmLine.Provider>;
}

export function StartDraftSubmit({
  confirm,
  disabled,
  size,
}: {
  confirm: string;
  disabled: boolean;
  size: ButtonSize;
}) {
  const line = useContext(ConfirmLine);
  return (
    <SubmitButton
      variant="accent"
      size={size}
      disabled={disabled}
      confirm={confirm + line}
    >
      Start draft
    </SubmitButton>
  );
}
