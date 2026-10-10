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

  it("shows the invite list and its copy only when the bot reported seats", () => {
    expect(code).toMatch(
      /const players =\s*view\?\.enabled && state === "ready" && view\.players\?\.length/,
    );
    expect(code).toMatch(/\{players \? \(/);
  });

  it("sends only the kind, id and action: never invite targets", () => {
    expect(code).toMatch(/body: JSON\.stringify\(\{ kind, id, action \}\)/);
    expect(code).not.toMatch(/withPlayers|steamId|invite:/);
  });
});
