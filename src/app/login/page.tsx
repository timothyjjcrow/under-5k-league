import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { Card, CardBody } from "@/components/ui";

export const metadata = { title: "Sign in · Under 5k League" };

export default async function LoginPage() {
  const user = await getSessionUser();
  if (user) redirect("/");

  const devLogin = process.env.ALLOW_DEV_LOGIN === "true";

  return (
    <div className="mx-auto max-w-md">
      <Card>
        <CardBody className="space-y-6 text-center">
          <div>
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-xl bg-brand text-xl font-bold text-brand-fg">
              5K
            </div>
            <h1 className="mt-4 text-2xl font-bold">Welcome to Under 5k League</h1>
            <p className="mt-1 text-sm text-muted">
              Sign in with Steam to join the season.
            </p>
          </div>

          <a
            href="/api/auth/steam"
            className="flex h-12 w-full items-center justify-center gap-3 rounded-lg bg-[#1b2838] px-4 font-medium text-white transition-colors hover:bg-[#223247]"
          >
            <SteamIcon />
            Sign in through Steam
          </a>

          {devLogin ? (
            <div className="space-y-3 border-t border-line pt-5 text-left">
              <p className="text-center text-xs uppercase tracking-wide text-muted">
                Developer quick login
              </p>
              <div className="grid grid-cols-2 gap-2">
                <DevLoginLink
                  label="Admin"
                  href="/api/auth/dev?name=Admin&steamId=76561190000000001&admin=1"
                  accent
                />
                <DevLoginLink
                  label="Player"
                  href="/api/auth/dev?name=Test+Player&steamId=76561190000000002"
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
          ? "rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-center text-sm font-medium text-accent hover:bg-accent/20"
          : "rounded-lg border border-line bg-surface-2 px-3 py-2 text-center text-sm font-medium hover:border-muted/60"
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
