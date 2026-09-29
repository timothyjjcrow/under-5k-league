import { describe, expect, it } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DISCORD_INVITE_URL } from "@/lib/constants";
import { AccountDiscordCard } from "./account-discord-card";

type Props = ComponentProps<typeof AccountDiscordCard>;

const noop = async () => null;
const base: Props = {
  discordId: null,
  discordName: null,
  membership: null,
  linkAvailable: true,
  autoJoins: true,
  isCaptain: false,
  warnBeforeLeaving: false,
  pingOptIn: { available: false, on: false },
  unlinkAction: noop,
  saveHandleAction: noop,
  pingAction: noop,
};
const render = (props: Partial<Props>) =>
  renderToStaticMarkup(createElement(AccountDiscordCard, { ...base, ...props }));

/** Visible text of every link and button, in order. */
function controls(html: string): string[] {
  return [...html.matchAll(/<(a|button)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) =>
    m[2]
      .replace(/<span aria-hidden="true">[^<]*<\/span>/g, "")
      .replace(/<svg[\s\S]*?<\/svg>/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .trim(),
  );
}

describe("AccountDiscordCard", () => {
  it("asks an unlinked player once, keeps the invite beside it, and folds the typed handle away", () => {
    const html = render({});
    const names = controls(html);
    expect(names.filter((n) => n === "Link Discord & join the server")).toHaveLength(1);
    expect(html).toContain('href="/api/auth/discord"');
    if (DISCORD_INVITE_URL) {
      expect(names).toContain("Use the invite instead");
      expect(html).toContain(`href="${DISCORD_INVITE_URL}"`);
    }
    expect(html).toMatch(
      /<details[^>]*><summary[^>]*>Can(&#x27;|')t link\? Type your handle<\/summary>/,
    );
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    // The old placeholder started mid-sentence.
    expect(html).not.toContain("or type it");
  });

  it("shows the typed handle form openly where linking isn't set up", () => {
    const html = render({ linkAvailable: false, autoJoins: false });
    expect(html).not.toContain("<details");
    expect(html).toContain('for="discord-handle"');
    expect(html).not.toContain("/api/auth/discord");
  });

  it("never renders an unknown membership as not in the server", () => {
    const html = render({ discordId: "1", discordName: "dendi" });
    expect(html).toContain("Linked ✓");
    expect(html).not.toContain("Not in the server");
    expect(html).not.toContain("isn&#x27;t in the league");
    expect(controls(html)).not.toContain("Join the server");
  });

  it("gives a linked non-member one join button and the invite", () => {
    const html = render({
      discordId: "1",
      discordName: "gone4",
      membership: "not-member",
    });
    expect(html).toContain("Not in the server");
    expect(html).toContain("(@gone4) isn&#x27;t in the league");
    const names = controls(html);
    expect(names.filter((n) => n === "Join the server")).toHaveLength(1);
    if (DISCORD_INVITE_URL) expect(names).toContain("Use the invite instead");
    expect(names).toContain("Unlink");
  });

  it("points a pending member at Discord, and a member at nothing", () => {
    const pending = render({
      discordId: "1",
      discordName: "p",
      membership: "pending",
    });
    expect(pending).toContain("Rules pending");
    if (DISCORD_INVITE_URL) expect(controls(pending)).toContain("Open Discord");

    const member = render({
      discordId: "1",
      discordName: "m",
      membership: "member",
    });
    expect(member).toContain("In the server ✓");
    expect(controls(member)).not.toContain("Join the server");
    expect(controls(member)).not.toContain("Open Discord");
  });

  it("never renders two controls with one name in any state", () => {
    const states: Partial<Props>[] = [
      {},
      { autoJoins: false },
      { linkAvailable: false, autoJoins: false },
      { discordId: "1", discordName: "a", membership: "not-member" },
      { discordId: "1", discordName: "a", membership: "pending" },
      { discordId: "1", discordName: "a", membership: null, param: "join_failed" },
      { discordId: "1", discordName: "a", membership: "member" },
    ];
    for (const state of states) {
      const names = controls(render(state)).filter(Boolean);
      expect(new Set(names).size, JSON.stringify(state)).toBe(names.length);
    }
  });
});
