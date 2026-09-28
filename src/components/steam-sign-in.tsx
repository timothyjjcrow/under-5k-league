import type * as React from "react";
import { STEAM_SIGN_IN_NOTICE, steamSignInHref } from "@/lib/sign-in-link";
import { cn } from "@/lib/utils";
import {
  ShieldCheckIcon,
  buttonClasses,
  textLink,
  type ButtonSize,
  type ButtonVariant,
} from "./ui";

/**
 * A signed-out join button that goes straight to Steam (see
 * steamSignInHref). Render SteamSignInNote beside it, or use SteamJoin.
 */
export function SteamSignInButton({
  next,
  variant = "primary",
  size = "lg",
  className,
  children,
}: {
  /** Where to land after sign-in: "/me" is the signup form. */
  next: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: React.ReactNode;
}) {
  // A plain <a>: next/link would prefetch the Steam route, which starts a
  // sign-in and replaces its state cookie. nofollow: crawlers have no
  // business starting one either (robots.txt also keeps them out of /api).
  return (
    <a
      href={steamSignInHref(next)}
      rel="nofollow"
      className={buttonClasses(variant, size, className)}
    >
      {children}
    </a>
  );
}

/**
 * The same sign-in as an inline text link, for a secondary line under a
 * main button ("New here? Sign in to join as a standin"). A plain <a> for
 * the same reason as the button.
 */
export function SteamSignInLink({
  next,
  className,
  children,
}: {
  next: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <a href={steamSignInHref(next)} rel="nofollow" className={textLink(className)}>
      {children}
    </a>
  );
}

/** What signing in shares, beside every button that skips /login. */
export function SteamSignInNote({ className }: { className?: string }) {
  return (
    <p className={cn("flex gap-1.5 text-left text-xs leading-relaxed text-muted", className)}>
      <ShieldCheckIcon size={14} className="mt-0.5 shrink-0 text-success" />
      <span>{STEAM_SIGN_IN_NOTICE}</span>
    </p>
  );
}

/** The button with its note under it, for a page title's action slot. */
export function SteamJoin({
  next,
  size = "md",
  children,
}: {
  next: string;
  size?: ButtonSize;
  children: React.ReactNode;
}) {
  return (
    <div className="flex max-w-sm flex-col gap-2">
      <SteamSignInButton next={next} size={size} className="self-start">
        {children}
      </SteamSignInButton>
      <SteamSignInNote />
    </div>
  );
}
