import Link from "next/link";
import { getActiveSeason } from "@/lib/season";
import { DraftRoom } from "@/components/draft-room";
import { EmptyState, PageTitle, buttonClasses } from "@/components/ui";

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

  return (
    <div className="space-y-6">
      <PageTitle
        title="Draft room"
        subtitle={`${season.name} · live auction draft`}
      />
      {/* The room handles every draft status itself (waiting → live →
          complete) via its poll. A server-rendered gate here went stale the
          moment the admin clicked start, stranding the whole league on a
          dead page at the worst possible time — nominations run on a clock. */}
      <DraftRoom draftAtMs={season.draftAt?.getTime() ?? null} />
    </div>
  );
}
