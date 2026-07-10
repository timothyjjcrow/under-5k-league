import Link from "next/link";
import { getActiveSeason } from "@/lib/season";
import { prisma } from "@/lib/prisma";
import { DraftRoom } from "@/components/draft-room";
import { EmptyState, PageTitle, Badge, buttonClasses } from "@/components/ui";

export const metadata = { title: "Draft" };

export default async function DraftPage() {
  const season = await getActiveSeason();

  if (!season || season.status !== "DRAFT") {
    return (
      <div>
        <PageTitle title="Draft" />
        <EmptyState
          title="The draft isn't running"
          description="This page opens for the live auction while the season is in its draft phase."
          action={
            <Link href="/" className={buttonClasses("secondary")}>
              Back to home
            </Link>
          }
        />
      </div>
    );
  }

  const draft = await prisma.draft.findUnique({
    where: { seasonId: season.id },
  });

  return (
    <div className="space-y-6">
      <PageTitle
        title="Draft room"
        subtitle={`${season.name} · live auction draft`}
        action={
          <Badge tone={draft?.status === "IN_PROGRESS" ? "accent" : "neutral"}>
            {draft?.status === "IN_PROGRESS"
              ? "Live"
              : draft?.status === "COMPLETE"
                ? "Complete"
                : "Not started"}
          </Badge>
        }
      />
      {draft?.status === "IN_PROGRESS" || draft?.status === "COMPLETE" ? (
        <DraftRoom />
      ) : (
        <EmptyState
          title="Draft hasn't started yet"
          description="An admin will start the auction from the admin panel."
          action={
            <Link href="/admin" className={buttonClasses("accent")}>
              Go to admin
            </Link>
          }
        />
      )}
    </div>
  );
}
