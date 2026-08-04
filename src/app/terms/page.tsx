import Link from "next/link";
import { Card, CardBody, PageTitle, textLink } from "@/components/ui";
import { shareMetadata } from "@/lib/share-metadata";
import { normalizePrivacyContactEmail } from "@/lib/privacy-contact.mjs";

export const metadata = shareMetadata(
  "League terms",
  "The participation, conduct, public-record, external-service, and play-money terms for the GGD2L amateur Dota 2 league.",
  "/terms",
);

const EXTERNAL_LINK =
  "rounded text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";

export default function TermsPage() {
  const contactEmail = normalizePrivacyContactEmail(
    process.env.PRIVACY_CONTACT_EMAIL,
  );

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageTitle
        title="League terms"
        subtitle="The practical rules for using the site and participating in this community-run amateur league."
      />

      <TermsSection title="Community league">
        <p>
          GGD2L is an independent community competition. It is not affiliated
          with, sponsored by, or endorsed by Valve, Steam, Dota 2, Discord, or
          OpenDota. League administrators organize the competition and make the
          operational and rules decisions described on the site and in the
          league&apos;s published rules.
        </p>
      </TermsSection>

      <TermsSection title="Eligibility and account control">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Use only Steam and Discord accounts you control. Do not share
            passwords, login codes, session cookies, or impersonate another
            player.
          </li>
          <li>
            You must be at least 13 and meet any higher minimum age required in
            your country to use the Discord integration. If you cannot legally
            agree to these terms on your own, a parent or guardian must approve
            your participation before you sign in or submit league data.
          </li>
          <li>
            League operators must confirm any additional local age, guardian,
            tournament, or data-protection requirements before opening the
            service to a jurisdiction.
          </li>
        </ul>
      </TermsSection>

      <TermsSection title="Fair participation">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Give accurate signup, MMR, availability, account, and match-result
            information. Do not manipulate the draft, wagers, polls, results,
            rankings, or another participant&apos;s account.
          </li>
          <li>
            Follow the league&apos;s conduct and competition rules. Administrators
            may correct data, rule on eligibility or forfeits, remove a signup,
            revoke access, or preserve audit evidence when reasonably needed to
            run or protect the league.
          </li>
          <li>
            Site phases and locks are authoritative for online actions. A UI or
            external-data error does not override an administrator&apos;s recorded
            ruling or the competition rules.
          </li>
        </ul>
      </TermsSection>

      <TermsSection title="Public league record">
        <p>
          Player profiles, signup scouting answers, rosters, draft activity,
          schedules, results, statistics, fantasy/prediction outcomes, inhouse
          activity, and historical seasons can be public. By joining a season,
          you ask the league to use and periodically refresh the public Steam
          and Dota data needed to operate that competition. Review the{" "}
          <Link href="/privacy" className={textLink()}>
            Privacy &amp; data use notice
          </Link>{" "}
          before signing in or participating.
        </p>
      </TermsSection>

      <TermsSection title="External data and services">
        <p>
          Steam, Steam Web API data and links, OpenDota, Discord, and other
          external services may be delayed, incomplete, inaccurate,
          interrupted, changed, or unavailable. They are provided on an “as
          is,” “with all faults,” and “as available” basis. To the maximum
          extent permitted by law, the league and those external suppliers make
          no promise that this data or service is error-free, accurate, secure,
          fit for a particular purpose, merchantable, non-infringing, or always
          available.
        </p>
        <p>
          To the maximum extent permitted by law, Valve, Steam game publishers
          and developers, Discord, OpenDota, and their suppliers are not liable
          through this league for indirect, consequential, special, incidental,
          or punitive damages caused by access to, use of, or inability to use
          those services or data. Rights that cannot legally be excluded still
          apply.
        </p>
        <p>
          Their own terms also apply: the{" "}
          <a
            href="https://store.steampowered.com/subscriber_agreement/"
            target="_blank"
            rel="noreferrer"
            className={EXTERNAL_LINK}
          >
            Steam Subscriber Agreement ↗
          </a>
          ,{" "}
          <a
            href="https://steamcommunity.com/dev/apiterms"
            target="_blank"
            rel="noreferrer"
            className={EXTERNAL_LINK}
          >
            Steam Web API terms ↗
          </a>
          , and{" "}
          <a
            href="https://discord.com/terms"
            target="_blank"
            rel="noreferrer"
            className={EXTERNAL_LINK}
          >
            Discord terms ↗
          </a>
          .
        </p>
      </TermsSection>

      <TermsSection title="No money or prize account">
        <p>
          Inhouse Cred is play money with no cash value. It cannot be bought,
          sold, withdrawn, transferred between players, or redeemed for a prize
          through this application. The site does not process payments or offer
          real-money gambling.
        </p>
      </TermsSection>

      <TermsSection title="Changes, suspension, and contact">
        <p>
          Features or external integrations may change or stop when necessary
          for security, maintenance, provider rules, league operations, or law.
          Material updates to these terms or the privacy notice should be dated
          and announced before they govern new participation.
        </p>
        {contactEmail ? (
          <p>
            Questions or reports can be sent to{" "}
            <a href={`mailto:${contactEmail}`} className={textLink()}>
              {contactEmail}
            </a>
            . Do not send passwords, login codes, API keys, or identity
            documents.
          </p>
        ) : (
          <p role="note">
            The contact mailbox is intentionally unavailable in this
            non-production build; production validation requires it.
          </p>
        )}
        <p className="text-xs">Effective August 4, 2026.</p>
      </TermsSection>
    </div>
  );
}

function TermsSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardBody className="space-y-3 text-sm leading-relaxed text-muted">
        <h2 className="font-display text-xl font-semibold text-fg">{title}</h2>
        {children}
      </CardBody>
    </Card>
  );
}
