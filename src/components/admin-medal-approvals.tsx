import { ActionForm, SubmitButton } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { Badge, CardBody, PlayerLink, RankMedal } from "@/components/ui";
import {
  approveMedalApproval,
  declineMedalApproval,
  removeMedalApprovalAction,
} from "@/app/actions/admin-medal-approvals";
import { HARD_MMR_CEILING, MEDAL_APPROVAL_STATUS } from "@/lib/constants";
import { formatLeagueMatchTime } from "@/lib/match-time";
import {
  defaultApprovalMmr,
  MEDAL_APPROVAL_MMR_MAX,
} from "@/lib/medal-approval";
import type { MedalApprovalAdminRow } from "@/lib/medal-approval-service";
import { rankMedalName } from "@/lib/rank";

const MMR_FORMAT = new Intl.NumberFormat("en-US");

function When({ at }: { at: Date }) {
  return (
    <LocalTime
      ts={at.getTime()}
      variant="short"
      initial={formatLeagueMatchTime(at, "short")}
    />
  );
}

/** Approve at an MMR: the number starts at the medal's floor. */
function ApproveForm({ row }: { row: MedalApprovalAdminRow }) {
  const start = defaultApprovalMmr(row.user.rankTier ?? row.askedRankTier);
  const boxId = `medal-approval-mmr-${row.id}`;
  return (
    <ActionForm
      action={approveMedalApproval}
      hidden={{ approvalId: row.id, status: row.status }}
      className="flex flex-wrap items-end gap-2"
    >
      <div className="min-w-0">
        <label htmlFor={boxId} className="block text-xs font-medium">
          MMR they play at
        </label>
        <input
          id={boxId}
          name="mmr"
          type="number"
          required
          min={1}
          max={MEDAL_APPROVAL_MMR_MAX}
          defaultValue={start ?? ""}
          className="mt-1 h-9 w-28 rounded-lg border border-line bg-surface-2/50 px-3 text-sm tabular-nums outline-none focus:border-accent/60"
        />
      </div>
      <SubmitButton size="sm">Approve</SubmitButton>
    </ActionForm>
  );
}

function RemoveForm({ row }: { row: MedalApprovalAdminRow }) {
  const approved = row.status === MEDAL_APPROVAL_STATUS.APPROVED;
  return (
    <ActionForm
      action={removeMedalApprovalAction}
      hidden={{ approvalId: row.id, status: row.status }}
    >
      <SubmitButton
        size="sm"
        variant="ghost"
        confirm={
          approved
            ? `Remove ${row.user.name}'s approval? Their medal is checked again at signup and at every inhouse join. A signup or queue spot they already have stays.`
            : `Remove ${row.user.name}'s request? They can ask again.`
        }
      >
        {approved ? "Remove approval" : "Remove request"}
      </SubmitButton>
    </ActionForm>
  );
}

/**
 * /admin's Medal limit approvals (medal-approval.ts): every request from a
 * player over the medal line, pending first. Pending: approve at an MMR or
 * decline. Declined: still approvable. Approved: the number and who set it.
 * Every row can be removed.
 */
export function AdminMedalApprovals({ rows }: { rows: MedalApprovalAdminRow[] }) {
  return (
    <CardBody className="space-y-3">
      <p className="text-sm text-muted">
        A Divine 3 or higher medal, or Immortal, is over the league&apos;s{" "}
        {MMR_FORMAT.format(HARD_MMR_CEILING)} MMR line, so signups and the
        inhouse queue turn it away. Those players ask here from My account,
        and the bot messages each admin with a linked Discord. Approving lets
        them sign up and join inhouses at the MMR you set: a new signup is
        stored at it, every inhouse join uses it unless you set an inhouse MMR
        on Inhouse players, and they can&apos;t change it themselves.
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">No requests yet.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => {
            const medal = row.user.rankTier ?? row.askedRankTier;
            return (
              <li
                key={row.id}
                data-testid="medal-approval-row"
                className="min-w-0 space-y-2 rounded-lg border border-line bg-surface-2/40 p-3"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <RankMedal rankTier={medal} size={20} />
                  <PlayerLink
                    userId={row.user.id}
                    className="min-w-6 truncate font-medium"
                  >
                    {row.user.name}
                  </PlayerLink>
                  <span className="text-xs text-muted">{rankMedalName(medal)}</span>
                  {row.status === MEDAL_APPROVAL_STATUS.PENDING ? (
                    <Badge tone="accent">Waiting</Badge>
                  ) : row.status === MEDAL_APPROVAL_STATUS.APPROVED ? (
                    <Badge tone="success">Approved</Badge>
                  ) : (
                    <Badge>Declined</Badge>
                  )}
                </div>
                <p className="text-xs text-muted">
                  Asked <When at={row.requestedAt} />
                  {row.status === MEDAL_APPROVAL_STATUS.APPROVED && row.mmr ? (
                    <>
                      {" · approved at "}
                      <span className="tabular-nums text-fg">
                        {MMR_FORMAT.format(row.mmr)}
                      </span>
                      {" MMR"}
                    </>
                  ) : null}
                  {row.status !== MEDAL_APPROVAL_STATUS.PENDING && row.decidedAt ? (
                    <>
                      {` · ${row.status === MEDAL_APPROVAL_STATUS.APPROVED ? "approved" : "declined"} by ${row.decidedByName ?? "an admin"} `}
                      <When at={row.decidedAt} />
                    </>
                  ) : null}
                </p>
                {row.note ? (
                  <p className="text-sm [overflow-wrap:anywhere]">
                    &ldquo;{row.note}&rdquo;
                  </p>
                ) : null}
                <div className="flex flex-wrap items-end gap-3">
                  {row.status !== MEDAL_APPROVAL_STATUS.APPROVED ? (
                    <ApproveForm row={row} />
                  ) : null}
                  {row.status === MEDAL_APPROVAL_STATUS.PENDING ? (
                    <ActionForm
                      action={declineMedalApproval}
                      hidden={{ approvalId: row.id }}
                    >
                      <SubmitButton size="sm" variant="secondary">
                        Decline
                      </SubmitButton>
                    </ActionForm>
                  ) : null}
                  <RemoveForm row={row} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </CardBody>
  );
}
