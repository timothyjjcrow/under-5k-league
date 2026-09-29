import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
