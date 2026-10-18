import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  sourceFile,
  stripLineComments,
} from "../../test/support/source-files";
import {
  DotaLobbyControls,
  lobbyPanelVisible,
  type LobbyBotAvailability,
} from "./dota-lobby-controls";

const ALL: LobbyBotAvailability[] = ["checking", "off", "on", "unavailable"];

describe("lobbyPanelVisible", () => {
  it("always shows the hosts' panel, which explains a missing or failing bot", () => {
    for (const availability of ALL)
      expect(lobbyPanelVisible("host", availability)).toBe(true);
  });

  // The match page's players can't connect the bot or set a ticket, and the
  // manual hosting steps the "off" copy points at are in Captain tools, which
  // isn't on their page. Their panel appears only with a lobby to show.
  it("shows the players' panel only once the bot answers with a lobby", () => {
    expect(ALL.filter((a) => lobbyPanelVisible("player", a))).toEqual(["on"]);
  });
});

describe("DotaLobbyControls first render", () => {
  it("renders nothing for players while it checks, and the panel for hosts", () => {
    const render = (audience?: "host" | "player") =>
      renderToStaticMarkup(
        createElement(DotaLobbyControls, { kind: "season", id: "m1", audience }),
      );
    expect(render("player")).toBe("");
    expect(render()).toContain("Steam lobby bot");
    expect(render("host")).toBe(render());
  });
});

// SOURCE GUARD: vitest runs without jsdom, so the panel's invite controls are
// checked in its source. Each button renders through the same predicate the
// route's acceptance builds on (lobbyInviteScope), the list's words come from
// the tested pure row and toast functions, and the browser never names an
// invite's targets: the server picks them from the roster.
describe("DotaLobbyControls invite controls (source)", () => {
  const code = stripLineComments(
    sourceFile("src/components/dota-lobby-controls.tsx").text,
  );
  // The predicate guarding the one <button> whose label is `name`.
  const button = (name: string) =>
    new RegExp(
      `\\{(\\w+)\\(view\\) \\? \\(\\s*<button(?:(?!</button>)[^])*>\\s*${name}\\s*</button>`,
    );

  it("renders each invite button only through its predicate", () => {
    expect(code.match(button("Re-invite missing players"))?.[1]).toBe(
      "reinviteMissingOpen",
    );
    expect(code.match(button("Send me an invite"))?.[1]).toBe("selfInviteOpen");
    // One button each, one accessible name each.
    expect(code.match(/Re-invite missing players/g)).toHaveLength(1);
    expect(code.match(/Send me an invite/g)).toHaveLength(1);
  });

  it("words rows and invite results through the tested helpers", () => {
    expect(code).toMatch(/lobbyPlayerRow\(player\)/);
    expect(code).toMatch(/noPopupHelp\(view\.inviteScope\)/);
    expect(code).toMatch(/inviteResultToast\(\{/);
    // A lost answer, on either leg, is unknown: the route's `unknown` flag
    // and a fetch that never answered both get the neutral toast.
    expect(code).toMatch(
      /if \(inviteScope && body\?\.unknown === true\)\s*pushToast\("info", inviteUnknownToast\(inviteScope\)\)/,
    );
    expect(code.match(/pushToast\("info", inviteUnknownToast\(inviteScope\)\)/g)).toHaveLength(2);
    expect(code).toMatch(/Who&apos;s in the lobby/);
  });

  it("shows the seat list only when the bot reported seats, while ready or starting", () => {
    expect(code).toMatch(
      /const players =\s*view\?\.enabled && lobbyListVisible\(state\) && view\.players\?\.length/,
    );
    expect(code).toMatch(/\{players \? \(/);
    // The invite copy is for a ready lobby only: Dota starting the game has
    // its own line.
    expect(code).toMatch(
      /\{state === "ready" \? \(\s*<p className="text-xs text-muted">\s*The bot invites everyone/,
    );
  });

  it("sends only the kind, id and action: never invite targets", () => {
    expect(code).toMatch(/body: JSON\.stringify\(\{ kind, id, action \}\)/);
    expect(code).not.toMatch(/withPlayers|steamId|invite:/);
  });
});

// SOURCE GUARD: the release and game-over wording and the one Release button
// come from the tested pure helpers in src/lib/dota-lobby.ts.
describe("DotaLobbyControls lifecycle (source)", () => {
  const code = stripLineComments(
    sourceFile("src/components/dota-lobby-controls.tsx").text,
  );

  it("words the status line, a pending release and a game over through the helpers", () => {
    expect(code).toMatch(/lobbyStatusLabel\(view\.status\)/);
    expect(code).toMatch(/\{releasing \? \(\s*<p[^>]*>\{LOBBY_RELEASING_NOTE\}<\/p>\s*\) : over \? \(\s*<p[^>]*>\{LOBBY_OVER_NOTE\}<\/p>/);
  });

  it("offers Release only through releaseOpen, so never a second press while one is pending", () => {
    expect(code.match(button("Release bot…"))?.[1]).toBe("releaseOpen");
    expect(code).toMatch(/\{confirmRelease && releaseOpen\(view\) \? \(/);
  });

  // The predicate guarding the one <button> whose label is `name`.
  function button(name: string) {
    return new RegExp(
      `\\{(\\w+)\\(view\\) \\? \\(\\s*<button(?:(?!</button>)[^])*>\\s*${name}\\s*</button>`,
    );
  }
});

// SOURCE GUARD: the panel's refresh comes only from the tested pure rate, and
// its reads never hold the buttons' lock (2026-10-18: background polls shared
// it, so a read in flight disabled Create and Start and dropped clicks).
describe("DotaLobbyControls refresh (source)", () => {
  const code = stripLineComments(
    sourceFile("src/components/dota-lobby-controls.tsx").text,
  );
  /** One `const name = useCallback(...)` body, up to the next one. */
  const callback = (name: string) => {
    const start = code.indexOf(`const ${name} = useCallback(`);
    expect(start, name).toBeGreaterThan(0);
    const next = code.indexOf("= useCallback(", start + name.length + 20);
    return code.slice(start, next === -1 ? undefined : next);
  };

  it("sets its interval from lobbyPanelPollMs(state, playable, over)", () => {
    expect(code).toMatch(/const playable = view\?\.playable === true;/);
    expect(code).toMatch(
      /const every = lobbyPanelPollMs\(state, playable, over\);/,
    );
    expect(code).toMatch(/\[state, playable, over, read\]\);/);
    expect(code).toMatch(/if \(every === null\) return;/);
    expect(code).toMatch(/setInterval\([^]*?\}, every\);/);
    expect(code).not.toMatch(/\b5000\b|5_000|60_000|3_000|15_000/);
  });

  it("reads at once when the tab becomes visible again", () => {
    expect(code).toMatch(
      /document\.addEventListener\("visibilitychange", onVisible\)/,
    );
    expect(code).toMatch(
      /document\.removeEventListener\("visibilitychange", onVisible\)/,
    );
  });

  it("keeps background reads off the action lock, and lets an action win", () => {
    const read = callback("read");
    // A read never takes or releases the buttons' lock.
    expect(read).not.toMatch(/setPending|acting\.current = /);
    // It stands down while an action runs, and drops its answer once one
    // started after it was sent.
    expect(read).toMatch(/if \(acting\.current \|\| inFlightRead\.current\) return;/);
    expect(read).toMatch(/actions\.current !== since/);
    const act = callback("act");
    expect(act).toMatch(/actions\.current \+= 1;\s*[^]*?inFlightRead\.current\?\.abort\(\);/);
    expect(act).toMatch(/setPending\(true\)/);
    // Only the action lock disables a control.
    expect(code.match(/disabled=\{[^}]*\}/g)?.every((d) => d === "disabled={pending}")).toBe(true);
    // Polls and "Refresh bot status" read; the buttons act.
    expect(code).toMatch(/void read\(\)/);
    expect(code).not.toMatch(/request\(/);
  });
});
