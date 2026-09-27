import Link from "next/link";
import { Suspense } from "react";
import { getActiveSeason } from "@/lib/season";
import { getSessionUser } from "@/lib/auth";
import { loadStartDraftPreflight } from "@/lib/draft-start-preflight";
import { DraftRoom } from "@/components/draft-room";
import {
  StartDraftControl,
  StartDraftForm,
} from "@/components/admin-start-draft";
import { EmptyState, PageTitle, buttonClasses } from "@/components/ui";
import {
  pauseDraftAction,
  resumeDraftAction,
  undoLastSaleAction,
  voidCurrentLotAction,
} from "@/app/actions/admin";

export const metadata = { title: "Draft" };

export default async function DraftPage() {
  const season = await getActiveSeason();

  // Gate ONLY on "no active season". A status gate here is a static dead end:
  // the league parks on /draft during SIGNUPS waiting for draft night, and a
  // server-rendered "isn't running" page never learns the admin hit start —
  // the room's own poll handles waiting → live → complete seamlessly.
  if (!season) {
    return (
      <div>
        <PageTitle title="Draft" />
        <EmptyState
          title="The draft isn't running"
          description="This page opens for the live auction once a season exists."
          action={
            <Link href="/" className={buttonClasses("secondary")}>
              Back to home
            </Link>
          }
        />
      </div>
    );
  }

  // Admins get Start draft in the waiting room: the same form, action and
  // confirm as /admin's Captains & draft card (see admin-start-draft.tsx),
  // loaded only for them and only while there is something to start.
  const user = await getSessionUser();
  const preflight =
    user?.role === "ADMIN" ? await loadStartDraftPreflight(season) : null;
  const adminStart = preflight
    ? {
        blocker: preflight.blocker,
        // Same Suspense shape as /admin: the button is there at once with the
        // base confirm, and gains the Discord line when that lookup lands.
        control: (
          <Suspense
            fallback={
              <StartDraftForm
                seasonId={season.id}
                confirm={preflight.confirm}
                disabled={!preflight.canStart}
                size="md"
              />
            }
          >
            <StartDraftControl
              seasonId={season.id}
              confirmBase={preflight.confirm}
              disabled={!preflight.canStart}
              size="md"
            />
          </Suspense>
        ),
      }
    : undefined;

  return (
    <div className="space-y-4">
      {/* One line, not the site's two-line PageTitle: on a phone the old
          title, subtitle and divider sat ~120px above the auction clock on a
          screen where every pixel above the bid buttons costs time. */}
      <h1 className="flex min-w-0 items-baseline gap-2 font-display text-2xl font-semibold leading-tight tracking-tight text-fg">
        <span className="shrink-0">Draft room</span>{" "}
        <span className="min-w-0 truncate font-sans text-sm font-normal text-muted">
          {season.name}
        </span>
      </h1>
      {/* The room handles every draft status itself (waiting → live →
          complete) via its poll. A server-rendered gate here went stale the
          moment the admin clicked start, stranding the whole league on a
          dead page at the worst possible time — nominations run on a clock. */}
      <DraftRoom
        seasonId={season.id}
        pauseAction={pauseDraftAction}
        resumeAction={resumeDraftAction}
        undoAction={undoLastSaleAction}
        voidLotAction={voidCurrentLotAction}
        adminStart={adminStart}
      />
    </div>
  );
}
