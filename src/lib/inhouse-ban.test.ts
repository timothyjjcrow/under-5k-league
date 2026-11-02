import { describe, expect, it } from "vitest";
import {
  activeInhouseBans,
  cleanInhouseBanReason,
  inhouseBanActive,
  inhouseBanEndsAt,
  inhouseBanRefusal,
  inhouseBanRoleStep,
  inhouseBanSavedMessage,
  inhouseBanWakeAtMs,
  INHOUSE_BAN_REASON_MAX,
  INHOUSE_BAN_ROLE_GRANT_RETRY_MS,
  INHOUSE_BAN_ROLE_REMOVE_RETRY_MS,
  parseInhouseBanForm,
  type InhouseBanRoleRow,
  type InhouseBanRow,
} from "./inhouse-ban";

const NOW = Date.UTC(2026, 10, 2, 18, 0, 0);
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(NOW + offsetMs);

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("inhouseBanActive", () => {
  it("runs until its end, forever when permanent, and never once lifted", () => {
    expect(inhouseBanActive({ endsAt: at(1), liftedAt: null }, NOW)).toBe(true);
    expect(inhouseBanActive({ endsAt: at(0), liftedAt: null }, NOW)).toBe(false);
    expect(inhouseBanActive({ endsAt: null, liftedAt: null }, NOW)).toBe(true);
    expect(inhouseBanActive({ endsAt: null, liftedAt: at(-1) }, NOW)).toBe(false);
    expect(inhouseBanActive({ endsAt: at(DAY), liftedAt: at(-1) }, NOW)).toBe(false);
  });
});

describe("inhouseBanEndsAt", () => {
  it("adds the chosen length, and permanent has no end", () => {
    expect(inhouseBanEndsAt("1d", NOW)?.getTime()).toBe(NOW + DAY);
    expect(inhouseBanEndsAt("1w", NOW)?.getTime()).toBe(NOW + 7 * DAY);
    expect(inhouseBanEndsAt("30d", NOW)?.getTime()).toBe(NOW + 30 * DAY);
    expect(inhouseBanEndsAt("permanent", NOW)).toBeNull();
  });
});

describe("parseInhouseBanForm", () => {
  it("reads a player, a length and a cleaned reason", () => {
    expect(
      parseInhouseBanForm(
        form({ userId: " u1 ", length: "3d", reason: "  Griefing\n and   leaving " }),
      ),
    ).toEqual({ ok: true, input: { userId: "u1", length: "3d", reason: "Griefing and leaving" } });
  });

  it("refuses a missing player, an unknown length and a blank reason", () => {
    expect(parseInhouseBanForm(form({ length: "1w", reason: "x" }))).toMatchObject({ ok: false });
    expect(
      parseInhouseBanForm(form({ userId: "u1", length: "1y", reason: "x" })),
    ).toMatchObject({ ok: false, error: "Choose how long the ban lasts." });
    expect(
      parseInhouseBanForm(form({ userId: "u1", length: "1w", reason: " \n " })),
    ).toMatchObject({ ok: false });
  });

  it("keeps a reason to one line of at most the limit", () => {
    const long = cleanInhouseBanReason("a".repeat(INHOUSE_BAN_REASON_MAX + 50));
    expect(long).toHaveLength(INHOUSE_BAN_REASON_MAX);
    expect(cleanInhouseBanReason("one\u0000two\r\nthree")).toBe("one two three");
  });
});

describe("activeInhouseBans", () => {
  const row = (over: Partial<InhouseBanRow> & { id: string; userId: string }): InhouseBanRow => ({
    reason: "griefing",
    createdAt: at(-DAY),
    endsAt: at(DAY),
    liftedAt: null,
    user: { name: over.userId, avatar: null },
    ...over,
  });

  it("drops ended and lifted bans and keeps the longest one per player", () => {
    const views = activeInhouseBans(
      [
        row({ id: "a", userId: "p1", endsAt: at(DAY) }),
        row({ id: "b", userId: "p1", endsAt: null, createdAt: at(-2 * DAY) }),
        row({ id: "c", userId: "p2", endsAt: at(-1) }),
        row({ id: "d", userId: "p3", liftedAt: at(-1) }),
        row({ id: "e", userId: "p4", createdAt: at(-1) }),
      ],
      NOW,
    );
    expect(views.map((v) => [v.id, v.endsAtMs])).toEqual([
      ["e", NOW + DAY],
      ["b", null],
    ]);
  });

  it("judges at the caller's clock, so a ban ending meanwhile goes", () => {
    const rows = [row({ id: "a", userId: "p1", endsAt: at(1_000) })];
    expect(activeInhouseBans(rows, NOW)).toHaveLength(1);
    expect(activeInhouseBans(rows, NOW + 1_000)).toHaveLength(0);
  });
});

describe("the words", () => {
  it("tells a banned player until when and why", () => {
    expect(inhouseBanRefusal({ endsAt: null, reason: "Leaving games" })).toBe(
      "You're banned from inhouse games permanently. Reason: Leaving games",
    );
    expect(inhouseBanRefusal({ endsAt: at(DAY), reason: "x" })).toMatch(
      /^You're banned from inhouse games until .+\. Reason: x$/,
    );
  });

  it("names a live game the ban leaves alone, and a replaced ban", () => {
    const msg = inhouseBanSavedMessage({
      name: "Pudge",
      endsAt: null,
      replaced: true,
      leftQueues: true,
      liveGame: "inhouse #1234",
      role: "given",
    });
    expect(msg).toContain("Pudge is banned from inhouse permanently.");
    expect(msg).toContain("This replaces their earlier ban.");
    expect(msg).toContain("They're out of the queue.");
    expect(msg).toContain("They're still in inhouse #1234");
    expect(msg).toContain("Inhouse Banned role");
  });
});

describe("inhouseBanRoleStep and inhouseBanWakeAtMs", () => {
  const base: InhouseBanRoleRow = {
    endsAt: at(DAY),
    liftedAt: null,
    roleAddedAt: null,
    roleTriedAt: null,
    discordId: "123456789012345678",
  };
  const on = { roleOn: true, otherActive: false };

  it("gives a missing role at once, then every retry window", () => {
    expect(inhouseBanRoleStep(base, NOW, on).kind).toBe("grant");
    const tried = { ...base, roleTriedAt: at(-1_000) };
    expect(inhouseBanRoleStep(tried, NOW, on).kind).toBe("wait");
    expect(
      inhouseBanRoleStep(tried, NOW - 1_000 + INHOUSE_BAN_ROLE_GRANT_RETRY_MS, on).kind,
    ).toBe("grant");
    // The gate wakes for that same retry, and for the ban's end.
    expect(inhouseBanWakeAtMs([tried], NOW, true)).toBe(
      NOW - 1_000 + INHOUSE_BAN_ROLE_GRANT_RETRY_MS,
    );
    const given = { ...base, roleAddedAt: at(-1), roleTriedAt: at(-1) };
    expect(inhouseBanRoleStep(given, NOW, on).kind).toBe("wait");
    expect(inhouseBanWakeAtMs([given], NOW, true)).toBe(NOW + DAY + 1);
  });

  it("gives nothing without a role, an account or the bot, and only wakes for the end", () => {
    expect(inhouseBanRoleStep(base, NOW, { ...on, roleOn: false }).kind).toBe("wait");
    expect(inhouseBanRoleStep({ ...base, discordId: null }, NOW, on).kind).toBe("wait");
    expect(inhouseBanWakeAtMs([base], NOW, false)).toBe(NOW + DAY + 1);
    expect(inhouseBanWakeAtMs([{ ...base, endsAt: null }], NOW, false)).toBeNull();
  });

  it("takes the role off when the ban ends or is lifted, and retries a refusal", () => {
    const given = { ...base, endsAt: at(-60_000), roleAddedAt: at(-DAY), roleTriedAt: at(-DAY) };
    expect(inhouseBanRoleStep(given, NOW, on).kind).toBe("remove");
    expect(inhouseBanWakeAtMs([given], NOW, true)).toBe(NOW);
    // Discord refused the removal 1s ago, after the end: it waits its retry.
    const refused = { ...given, roleTriedAt: at(-1_000) };
    expect(inhouseBanRoleStep(refused, NOW, on).kind).toBe("wait");
    expect(inhouseBanWakeAtMs([refused], NOW, true)).toBe(
      NOW - 1_000 + INHOUSE_BAN_ROLE_REMOVE_RETRY_MS,
    );
    expect(
      inhouseBanRoleStep(refused, NOW - 1_000 + INHOUSE_BAN_ROLE_REMOVE_RETRY_MS, on).kind,
    ).toBe("remove");
    const lifted = { ...base, liftedAt: at(-1), roleAddedAt: at(-DAY), roleTriedAt: at(-DAY) };
    expect(inhouseBanRoleStep(lifted, NOW, on).kind).toBe("remove");
  });

  it("settles a ban with nothing to undo, or whose role a newer ban owns", () => {
    const ended = { ...base, endsAt: at(-1) };
    expect(inhouseBanRoleStep(ended, NOW, on).kind).toBe("settle");
    expect(
      inhouseBanRoleStep({ ...ended, roleAddedAt: at(-DAY) }, NOW, { ...on, otherActive: true }).kind,
    ).toBe("settle");
    expect(inhouseBanRoleStep({ ...ended, roleAddedAt: at(-DAY) }, NOW, { ...on, roleOn: false }).kind).toBe(
      "settle",
    );
    expect(inhouseBanWakeAtMs([ended], NOW, false)).toBe(NOW);
  });

  it("wakes at the earliest of several bans", () => {
    expect(
      inhouseBanWakeAtMs(
        [
          { ...base, endsAt: at(3 * DAY), roleAddedAt: at(-1) },
          { ...base, endsAt: at(DAY), roleAddedAt: at(-1) },
        ],
        NOW,
        true,
      ),
    ).toBe(NOW + DAY + 1);
    expect(inhouseBanWakeAtMs([], NOW, true)).toBeNull();
  });
});
