import Link from "next/link";
import { Card, CardBody, PageTitle, textLink } from "@/components/ui";
import { shareMetadata } from "@/lib/share-metadata";
import {
  normalizePrivacyContactEmail,
  normalizePrivacyDataLocations,
} from "@/lib/privacy-contact.mjs";

export const metadata = shareMetadata(
  "Privacy & data use",
  "What GGD2L collects, what the amateur Dota 2 league publishes, which services receive data, and how participants can make a privacy request.",
  "/privacy",
);

const EXTERNAL_LINK =
  "rounded text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";

export default function PrivacyPage() {
  const contactEmail = normalizePrivacyContactEmail(
    process.env.PRIVACY_CONTACT_EMAIL,
  );
  const dataLocations = normalizePrivacyDataLocations(
    process.env.PRIVACY_DATA_LOCATIONS,
  );

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageTitle
        title="Privacy & data use"
        subtitle="A plain-language map of what this league stores, what other people can see, and how to ask for help."
      />

      <div className="rounded-xl border border-accent/35 bg-accent/10 p-4 text-sm leading-relaxed">
        <p className="font-medium text-fg">The important part</p>
        <p className="mt-1 text-muted">
          GGD2L is a public amateur competition. Your player identity, signup
          answers, team history, match activity, and competitive results can be
          public. Contact details and named availability are more restricted.
          Do not put private contact, health, or other sensitive information in
          a public signup field.
        </p>
      </div>

      <PrivacySection title="What we collect and why">
        <PrivacyList>
          <li>
            <b>Steam identity:</b> Steam verifies your stable SteamID64. We
            store that ID and fetch your public display name, avatar, and
            profile URL so one person has one recognizable league account.
          </li>
          <li>
            <b>Dota and OpenDota data:</b> we derive your Dota account ID from
            Steam and request public rank, public-match availability, recent
            activity, heroes, match details, and box scores. This powers
            eligibility checks, scouting, automatic results, standings, and
            statistics.
          </li>
          <li>
            <b>Signup data:</b> player or standin status, claimed MMR,
            preferred roles, favorite heroes, goals, captain interest, and the
            note you write for drafters. Administrators may correct eligibility
            or MMR records when running the league.
          </li>
          <li>
            <b>League activity:</b> teams, draft bids and prices, schedules,
            check-ins, standin assignments, results, game statistics, awards,
            fantasy rosters, predictions, inhouse participation, votes,
            play-money Cred activity, and administrative decisions needed to
            operate or audit the competition.
          </li>
          <li>
            <b>Discord:</b> you may type a handle or link an account. Linking
            stores Discord&apos;s stable account ID and current username. If the
            league bot is configured, it can add that linked account to the
            league server, check membership, and manage the optional inhouse
            ping role. The short-lived OAuth access token is discarded after
            the callback.
          </li>
        </PrivacyList>
      </PrivacySection>

      <PrivacySection title="What is public">
        <p>
          Public league pages can show your Steam display identity and profile
          link; Dota account, medal, and public-match snapshot; signup type,
          MMR, roles, favorite heroes, goals, captain interest and captain
          note; team, roster and draft price; schedules, match results, box
          scores, career statistics, awards and records; fantasy and prediction
          results after their competitive locks; and inhouse queue, lobby,
          result, vote, ladder and Cred information shown by those features.
        </p>
        <p>
          Public history is intentional: other players need to understand the
          draft and results, and completed seasons remain useful as the
          league&apos;s record. Search engines may index public pages, and copied or
          cached information can outlive a later site edit.
        </p>
      </PrivacySection>

      <PrivacySection title="What is restricted">
        <PrivacyList>
          <li>
            A Discord handle or linked-account status is limited to you,
            administrators, and current active league participants.
          </li>
          <li>
            Named match-night IN/OUT answers are limited to league
            administrators and the two affected captains; participants can see
            their own answer and permitted aggregate readiness.
          </li>
          <li>
            Draft confirmations, moderation context, security records,
            delivery failures, and detailed operator logs are available only
            to the people who need them to run or protect the league.
          </li>
          <li>
            Hosting, database, backup, and logging providers process data for
            the league under operator-controlled accounts. Access is not
            promised to be anonymous to those infrastructure providers.
          </li>
        </PrivacyList>
      </PrivacySection>

      <PrivacySection title="External services">
        <PrivacyList>
          <li>
            <a
              href="https://store.steampowered.com/privacy_agreement/"
              target="_blank"
              rel="noreferrer"
              className={EXTERNAL_LINK}
            >
              Steam / Valve privacy policy ↗
            </a>{" "}
            — sign-in, SteamID verification, and public profile lookup. Your
            Steam password is entered only on Steam; this site never receives
            it.
          </li>
          <li>
            <a
              href="https://www.opendota.com/"
              target="_blank"
              rel="noreferrer"
              className={EXTERNAL_LINK}
            >
              OpenDota ↗
            </a>{" "}
            — public Dota profile and match statistics. Requests identify the
            relevant Dota account or match.
          </li>
          <li>
            <a
              href="https://discord.com/privacy"
              target="_blank"
              rel="noreferrer"
              className={EXTERNAL_LINK}
            >
              Discord privacy policy ↗
            </a>{" "}
            — optional account linking, server membership and roles, plus
            configured league announcements that can include public player,
            team, schedule, result, and activity information.
          </li>
        </PrivacyList>
        <p>
          Public Steam avatars and administrator-approved external media may be
          loaded from their source, so your browser can contact that host. This
          site does not currently use advertising pixels, third-party
          behavioral analytics, or payment processing.
        </p>
        {dataLocations ? (
          <p>
            League-controlled copies of Steam profile data, the application
            database, backups, and application logs are stored or processed in:{" "}
            <b className="text-fg">{dataLocations}</b>. Steam, OpenDota,
            Discord, and infrastructure providers can process their own copies
            in other locations under their policies.
          </p>
        ) : (
          <div role="note" className="rounded-lg border border-line bg-surface-2/50 p-3">
            <p className="font-medium text-fg">
              Data storage locations are not configured in this non-production
              build.
            </p>
            <p className="mt-1 text-muted">
              Production validation refuses deployment until operators publish
              the verified countries used by hosting, database,
              backup, and logging providers.
            </p>
          </div>
        )}
      </PrivacySection>

      <PrivacySection title="Cookies and browser storage">
        <p>
          The site uses essential cookies only: a signed login session that can
          last up to 30 days, and ten-minute one-time cookies that protect Steam
          and Discord sign-in/linking redirects. They are HTTP-only; production
          cookies are secure and use same-site restrictions. A global emergency
          control can revoke existing sessions.
        </p>
        <p>
          Your browser also remembers optional live-room sound choices and a
          dismissed recent inhouse result in local storage. These values stay
          in that browser and are not advertising identifiers.
        </p>
      </PrivacySection>

      <PrivacySection title="Retention and your choices">
        <PrivacyList>
          <li>
            You can edit eligible profile/signup fields on <Link href="/me" className={textLink()}>Your profile</Link>,
            withdraw when the league state allows it, clear a typed Discord
            handle, or unlink Discord. Unlinking removes the stored Discord ID
            and handle and attempts to remove the optional ping role. It does
            not remove you from the Discord server, erase messages already sent
            there, or erase league history.
          </li>
          <li>
            Profile identity and competitive history are retained while the
            league operates so rosters, results, records, fraud controls, and
            season archives remain coherent. This first release does not offer
            an instant self-service account export or deletion button.
          </li>
          <li>
            A verified request can ask for access, correction, restriction, or
            deletion review. Some records may need to be retained, corrected,
            or de-identified instead of deleted where they affect other
            players, competitive integrity, security/audit evidence, backups,
            or legal obligations. The league will explain the outcome rather
            than silently claiming that every copy was erased.
          </li>
          <li>
            Backup copies follow the production provider&apos;s approved retention
            schedule and are not edited record by record. A restored backup
            must replay approved privacy corrections before general traffic is
            reopened.
          </li>
        </PrivacyList>
      </PrivacySection>

      <PrivacySection title="Contact and requests">
        {contactEmail ? (
          <p>
            Email{" "}
            <a href={`mailto:${contactEmail}`} className={textLink()}>
              {contactEmail}
            </a>{" "}
            with the request and the URL of the relevant player profile. Do not
            send passwords, session cookies, API keys, or identity documents.
            The operator will verify account control through the linked Steam
            account or another already-linked league channel before disclosing
            or changing private records.
          </p>
        ) : (
          <div role="note" className="rounded-lg border border-warning/40 bg-warning/10 p-3">
            <p className="font-medium text-fg">
              Privacy contact is not configured in this non-production build.
            </p>
            <p className="mt-1 text-muted">
              Production validation refuses deployment until a public request
              mailbox is configured.
            </p>
          </div>
        )}
        <p>
          This notice describes the application&apos;s current behavior; it is not
          a claim that every jurisdiction has the same rules. League operators
          must confirm any local age, consent, tournament, or data-protection
          requirements before opening signups.
        </p>
        <p>
          Participation is also subject to the{" "}
          <Link href="/terms" className={textLink()}>
            league terms
          </Link>
          .
        </p>
        <p className="text-xs text-muted">Effective August 4, 2026.</p>
      </PrivacySection>
    </div>
  );
}

function PrivacySection({
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

function PrivacyList({ children }: { children: React.ReactNode }) {
  return <ul className="list-disc space-y-2 pl-5">{children}</ul>;
}
