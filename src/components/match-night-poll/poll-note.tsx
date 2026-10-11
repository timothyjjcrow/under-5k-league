import Link from "next/link";
import { textLink } from "@/components/ui";
import { POLL_ANCHOR } from "@/lib/match-night-poll";

/**
 * What follows a match night the poll is deciding ("being decided in a
 * player poll") on a page the poll isn't on (/me, Schedule, How it works):
 * who votes, where, and what wins. Home's own callout says "in the poll
 * above" instead.
 */
export function MatchNightPollNote() {
  return (
    <>
      Signed-up players are voting on it{" "}
      <Link href={`/#${POLL_ANCHOR}`} className={textLink()}>
        on Home
      </Link>
      . The time the most can make wins.
    </>
  );
}
