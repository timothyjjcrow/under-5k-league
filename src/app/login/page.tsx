import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { safeReturnPath } from "@/lib/return-path";
import {
  Card,
  CardBody,
  DiscordButton,
  ShieldCheckIcon,
  SteamSafetyNote,
  textLink,
} from "@/components/ui";

export const metadata = { title: "Sign in" };

// The Steam callback bounces failures back here as ?error=<code>. Map only
// KNOWN codes to copy — never echo the raw query value (injection/phishing
// hygiene); anything unknown gets the generic line.
const LOGIN_ERRORS: Record<string, string> = {
  steam: "Steam didn't confirm your sign-in — give it another try.",
  rate: "Too many sign-in attempts — wait a minute, then try again.",
};
const GENERIC_LOGIN_ERROR = "Sign-in didn't go through — please try again.";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    next?: string;
    signedOut?: string;
  }>;
}) {
  const { error, next: rawNext, signedOut } = await searchParams;
  // Validated same-origin path to land on after sign-in (never echoed as
  // text; only ever used inside our own hrefs/redirects).
  const next = safeReturnPath(rawNext);

  const user = await getSessionUser();
  if (user) redirect(next ?? "/"); // already signed in → straight back

  // hasOwnProperty guard (the /me ?discord= pattern): a crafted
  // ?error=__proto__/constructor/toString resolves an inherited truthy
  // non-string past the ?? fallback and crashes the render as a JSX child.
  const errorCopy = error
    ? Object.prototype.hasOwnProperty.call(LOGIN_ERRORS, error)
      ? LOGIN_ERRORS[error]
      : GENERIC_LOGIN_ERROR
    : null;

  const steamHref = next
    ? `/api/auth/steam?next=${encodeURIComponent(next)}`
    : "/api/auth/steam";
  const devSuffix = next ? `&redirect=${encodeURIComponent(next)}` : "";

  const devLogin = process.env.ALLOW_DEV_LOGIN === "true";
  const intro =
    next === "/me"
      ? "Sign in to open your profile and continue setting up your league account."
      : next
        ? "Sign in to continue where you left off."
        : "Use Steam to create or return to your league profile.";

  return (
    <div className="mx-auto max-w-md">
      <Card>
        <CardBody className="space-y-6 text-center">
          <div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/ggd2l-logo.png"
              alt="GGD2L — amateur Dota 2 league"
              width={768}
              height={512}
              className="mx-auto w-44 max-w-full sm:w-52"
            />
            <h1 className="mt-3 font-display text-2xl font-semibold text-fg">
              Sign in to GGD2L
            </h1>
            <p className="mt-4 text-sm text-muted">
              {intro}
            </p>
          </div>

          {signedOut === "1" ? (
            <div
              role="status"
              className="rounded-lg border border-success/40 bg-success/10 px-3 py-2.5 text-sm text-success"
            >
              You&apos;re signed out. See you next match.
            </div>
          ) : null}

          {errorCopy ? (
            <div
              role="alert"
              className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2.5 text-sm text-danger"
            >
              {errorCopy}
            </div>
          ) : null}

          <div className="space-y-2">
            <a
              href={steamHref}
              className="flex h-12 w-full items-center justify-center gap-3 rounded-lg bg-[#1b2838] px-4 font-medium text-white transition-colors hover:bg-[#223247] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <SteamIcon />
              Sign in through Steam
            </a>
            <p className="flex items-center justify-center gap-1.5 text-[11px] text-muted">
              <ShieldCheckIcon size={13} className="text-success" />
              Secure — you sign in on Steam, no password shared.
            </p>
          </div>

          <SteamSafetyNote />

          <div className="space-y-3 border-t border-line pt-5">
            <div>
              <h2 className="font-display text-base font-semibold text-fg">
                Join the league community
              </h2>
              <p className="mt-1 text-xs text-muted">
                Steam signs you into this site. Discord is where the league
                coordinates matches and announcements.
              </p>
            </div>
            <DiscordButton label="Join the community Discord" className="w-full" />
          </div>

          {devLogin ? (
            <div className="space-y-3 border-t border-line pt-5 text-left">
              <p className="text-center text-xs uppercase tracking-wide text-muted">
                Developer quick login
              </p>
              <div className="grid grid-cols-2 gap-2">
                <DevLoginLink
                  label="Admin"
                  href={`/api/auth/dev?name=Admin&steamId=76561190000000001&admin=1${devSuffix}`}
                  accent
                />
                <DevLoginLink
                  label="Player"
                  href={`/api/auth/dev?name=Test+Player&steamId=76561190000000002${devSuffix}`}
                />
              </div>
              <p className="text-center text-[11px] text-muted">
                Only shown because ALLOW_DEV_LOGIN=true. Disable in production.
              </p>
            </div>
          ) : null}
        </CardBody>
      </Card>

      <p className="mt-6 text-center text-sm text-muted">
        Just looking? You can{" "}
        <Link href="/players" className={textLink()}>
          browse the league
        </Link>{" "}
        without signing in — use Steam when you&apos;re ready to participate or
        manage your profile.
      </p>
      <p className="mt-2 text-center text-sm text-muted">
        <Link href="/" className="hover:text-fg">
          ← Back to home
        </Link>
      </p>
    </div>
  );
}

function DevLoginLink({
  label,
  href,
  accent,
}: {
  label: string;
  href: string;
  accent?: boolean;
}) {
  return (
    <a
      href={href}
      className={
        accent
          ? "flex min-h-11 items-center justify-center rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-center text-sm font-medium text-accent hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          : "flex min-h-11 items-center justify-center rounded-lg border border-line bg-surface-2 px-3 py-2 text-center text-sm font-medium hover:border-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      }
    >
      {label}
    </a>
  );
}

function SteamIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 0C5.6 0 .3 4.9 0 11.1l6.4 2.6c.5-.4 1.2-.6 1.9-.6h.2l2.9-4.2v-.1c0-2.5 2-4.5 4.5-4.5s4.6 2 4.6 4.6-2 4.6-4.6 4.6h-.1L11.6 16v.2c0 1.9-1.5 3.4-3.4 3.4-1.6 0-3-1.2-3.3-2.7L.3 15.1C1.8 20.3 6.4 24 12 24c6.6 0 12-5.4 12-12S18.6 0 12 0zM7.5 18.2l-1.5-.6c.3.6.8 1 1.5 1.3 1.4.6 3-.1 3.6-1.5.3-.7.3-1.4 0-2.1s-.8-1.2-1.5-1.5c-.7-.3-1.4-.3-2 0l1.5.6c1 .4 1.5 1.6 1 2.6s-1.6 1.3-2.6.8zm10.8-6.6c1.7 0 3-1.4 3-3s-1.3-3.1-3-3.1-3 1.4-3 3 1.3 3.1 3 3.1zm0-5.2c1.2 0 2.2 1 2.2 2.2s-1 2.2-2.2 2.2-2.3-1-2.3-2.2 1-2.2 2.3-2.2z" />
    </svg>
  );
}
