import type { ReactNode } from "react";
import Link from "@/components/app-link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { Badge, Card, CardBody, textLink } from "@/components/ui";
import {
  offerToStandInAction,
  withdrawStandinOfferAction,
} from "@/app/actions/standin-offers";
import { formatLeagueMatchTime } from "@/lib/match-time";
import {
  standinAcceptNamesSeats,
  standinNeedLabel,
  standinOfferOutcomeLine,
  standinOpenSeatLine,
  standinSeatLine,
  standinViewerMmrLine,
  type StandinOfferStanding,
} from "@/lib/standin-offer";
import type { StandinBoardNeed } from "@/lib/standin-offer-service";

/** The accept card's element id. */
export function acceptCardId(matchId: string, teamId: string): string {
  return `accept-${matchId}-${teamId}`;
}

/**
 * The game a shared standin link opened, at the top of the Standins page
 * (Tim, 2026-11-21): which team needs someone, against whom and when, who
 * the standin would replace and at what MMR, and one Accept button that puts
 * them on the list the captain picks from. Opening the link does nothing by
 * itself; Accept is the offer (`offerToStandInAction`), and the captain still
 * picks. Who is out is named only to a standin who could accept
 * (`standinAcceptNamesSeats`); everyone else sees the count and the MMR.
 */
export function StandinAcceptCard({
  need,
  standing,
  viewerMmr,
  signup,
}: {
  need: StandinBoardNeed;
  /** Where the viewer stands on this game (`standingOn`). */
  standing: StandinOfferStanding;
  /** The viewer's signup MMR; 0 = unknown, or no signup. */
  viewerMmr: number;
  /** What a visitor who can't accept yet does first: sign in, or register. */
  signup: ReactNode;
}) {
  const hidden = { matchId: need.matchId, teamId: need.teamId };
  const named = standinAcceptNamesSeats(standing);
  const titleId = `${acceptCardId(need.matchId, need.teamId)}-title`;
  return (
    <Card
      tone="feature"
      className="overflow-hidden"
      id={acceptCardId(need.matchId, need.teamId)}
      aria-labelledby={titleId}
    >
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <Badge tone="accent">Standin wanted</Badge>
          <Badge tone="info">{need.roundLabel}</Badge>
          <span className="text-muted">
            {need.scheduledAt ? (
              <LocalTime
                ts={need.scheduledAt.getTime()}
                variant="full"
                initial={formatLeagueMatchTime(need.scheduledAt, "full")}
              />
            ) : (
              "Time to be set"
            )}
          </span>
        </div>
        <div className="min-w-0">
          <h2
            id={titleId}
            className="font-display text-xl font-semibold [overflow-wrap:anywhere]"
          >
            Stand in for {need.teamName}
          </h2>
          <p className="text-sm text-muted [overflow-wrap:anywhere]">
            vs {need.opponentName}
            {" · "}
            <Link
              href={`/matches/${need.matchId}`}
              className={textLink("whitespace-nowrap")}
            >
              Match page
            </Link>
          </p>
        </div>
        {named ? (
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">
              {need.seats === 1 ? "You'd replace" : "Seats to fill"}
            </p>
            <ul
              aria-label={need.seats === 1 ? "You'd replace" : "Seats to fill"}
              className="divide-y divide-line-soft rounded-lg border border-line bg-surface-2/40"
            >
              {need.openSeats.map((seat, i) => {
                const line = standinOpenSeatLine(seat);
                return (
                  <li
                    key={seat.player?.userId ?? `empty-${i}`}
                    className="flex min-w-0 items-baseline justify-between gap-3 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 truncate font-medium">{line.who}</span>
                    <span className="shrink-0 tabular-nums text-muted">
                      {line.mmr}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <p className="text-sm">
            {need.teamName} {standinNeedLabel(need.seats)}.
            {standing.kind === "signed-out"
              ? " Sign in to see who you'd replace."
              : standing.kind === "no-signup"
                ? " Register as a standin to see who you'd replace."
                : ""}
          </p>
        )}
        <p className="text-sm text-muted">{standinSeatLine(need.baselineMmr)}</p>
        {standing.kind === "open" ? (
          <div className="space-y-2.5">
            <p className="text-sm">
              {standinViewerMmrLine(viewerMmr)}{" "}
              {standinOfferOutcomeLine(standing.outcome, need.opponentName)}
            </p>
            <ActionForm action={offerToStandInAction} hidden={hidden}>
              <SubmitButton variant="accent" size="lg">
                Accept
              </SubmitButton>
            </ActionForm>
            <p className="text-xs text-muted">
              Accepting puts you on the list for {need.teamName}. Their captain
              picks from everyone who accepted, and you&apos;re pinged on Discord
              if it&apos;s you.
            </p>
          </div>
        ) : standing.kind === "offered" ? (
          <div className="space-y-2">
            <p className="rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-sm">
              <span aria-hidden>✓ </span>
              You accepted: you&apos;re on the list.{" "}
              {standinOfferOutcomeLine(standing.outcome, need.opponentName, true)}{" "}
              You&apos;re pinged on Discord if it&apos;s you.
            </p>
            <ActionForm action={withdrawStandinOfferAction} hidden={hidden}>
              <SubmitButton variant="ghost" size="sm">
                Take me off the list
              </SubmitButton>
            </ActionForm>
          </div>
        ) : standing.kind === "blocked" ? (
          <p className="text-sm text-muted">{standing.reason}</p>
        ) : (
          signup
        )}
      </CardBody>
    </Card>
  );
}
