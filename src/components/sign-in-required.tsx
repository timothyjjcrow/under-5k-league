"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signInHref } from "@/lib/sign-in";

/**
 * The inline answer to a form pressed while signed out: a sign-in link that
 * comes back to this page, instead of a bare "Sign in required".
 */
export function SignInRequired() {
  const pathname = usePathname();
  return (
    <>
      You need to be signed in for that.{" "}
      <Link
        href={signInHref(pathname)}
        className="font-medium underline underline-offset-2"
      >
        Sign in
      </Link>{" "}
      and you&apos;ll come back to this page.
    </>
  );
}
