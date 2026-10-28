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
    // The invite copy is for a ready lobby with no release pending (it names
    // the invite buttons, which a pending release hides); Dota starting the
    // game has its own line.
    expect(code).toMatch(
      /\{state === "ready" && releasing \? null : state === "ready" \? \(\s*<p className="text-xs text-muted">\s*The bot invites everyone/,
    );
  });

  // 2026-10-18 review: on a two-game night the bot hosts game 1 for its whole
  // length, and game 2's panel showed the bot's lobby name and Create as if
  // the bot could host it.
  it("says which other game holds the bot, and offers Create only through createOpen", () => {
    expect(code).toMatch(/const busy = view\?\.status \? lobbyBusyElsewhere\(view\) : null;/);
    expect(code).toMatch(/\? busy\s*\? lobbyBusyLabel\(busy\)\s*: lobbyStatusLabel\(view\.status\)/);
    // A 1v1 waits for the bot instead of going by hand (lobbyBusyNote's kind).
    expect(code).toMatch(/lobbyBusyNote\(busy, view\.canControl, kind\)/);
    // No bot lobby will exist, so its name and password stay off the card.
    expect(code).toMatch(/\{busyLive \? null : \(\s*<dl/);
    expect(code).toMatch(
      /\{!recoveryOnly && createOpen\(view\) \? \(\s*<button(?:(?!<\/button>)[^])*>\s*Create Dota lobby\s*<\/button>/,
    );
    expect(code.match(/Create Dota lobby\s*<\/button>/g)).toHaveLength(1);
    // "busy" makes the setup card send the game to its by-hand steps.
    expect(code).toMatch(/\? busyLive\s*\? "busy"\s*: "on"/);
  });

  it("toasts BUSY's self-heal as progress, not as a failure", () => {
    expect(code).toMatch(
      /else if \(body\?\.freeing === true\)\s*pushToast\("info", routeError\(body\)\)/,
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

  it("words the status line, a pending release, a game over and a game the bot left through the helpers", () => {
    expect(code).toMatch(/lobbyStatusLabel\(view\.status\)/);
    expect(code).toMatch(
      /\{releasing \? \(\s*<p[^>]*>\{LOBBY_RELEASING_NOTE\}<\/p>\s*\) : over \? \(\s*<p[^>]*>\{LOBBY_OVER_NOTE\}<\/p>\s*\) : left \? \(\s*<p[^>]*>\{LOBBY_LEFT_NOTE\}<\/p>/,
    );
    expect(code).toMatch(/const left = view\?\.status\?\.left === true;/);
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

  it("sets its interval from lobbyPanelPollMs(state, playable, over, unanswered)", () => {
    expect(code).toMatch(/const playable = view\?\.playable === true;/);
    // A failed first read (no view, an error) retries by itself.
    expect(code).toMatch(/const unanswered = !view && error !== "";/);
    expect(code).toMatch(
      /const every = lobbyPanelPollMs\(state, playable, over, unanswered\);/,
    );
    expect(code).toMatch(/\[state, playable, over, unanswered, read\]\);/);
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

  // 2026-10-18 review: an action's failure (BUSY, "Freeing the bot…", "the
  // bot isn't running") was set inline, and the next 3s read cleared it
  // before the presser could read what to do.
  it("toasts an action's failures instead of setting them inline", () => {
    const act = callback("act");
    expect(act).not.toMatch(/setError\((?!"")/);
    expect(act).toMatch(/else pushToast\("error", routeError\(body\)\);/);
    expect(act).toMatch(/else pushToast\("error", UNREACHABLE\);/);
  });

  // Safari before 17.4 has no AbortSignal.any, and calling it throws: every
  // read of the panel failed there. Both panels bound their requests with
  // the portable requestSignal, which done() unhooks.
  it.each(["src/components/dota-lobby-controls.tsx", "src/components/dota-lobby-recovery.tsx"])(
    "%s never calls AbortSignal.any or AbortSignal.timeout",
    (file) => {
      const source = stripLineComments(sourceFile(file).text);
      expect(source).not.toMatch(/AbortSignal\.(any|timeout)/);
      expect(source).toMatch(/requestSignal\(/);
      expect(source).toMatch(/signal: request\.signal/);
      expect(source).toMatch(/request\.done\(\)/);
    },
  );
});

// SOURCE GUARD: the in-house seat summary ("All ten seated"), Start's
// highlight and the viewer's own seat for the setup card all come from the
// tested pure helpers (Tim's call, 2026-10-18).
describe("DotaLobbyControls seats (source)", () => {
  const code = stripLineComments(
    sourceFile("src/components/dota-lobby-controls.tsx").text,
  );

  it("words the seat summary through lobbySeatSummary, with Start's own predicate", () => {
    expect(code).toMatch(
      /lobbySeatSummary\(\{\s*kind,\s*playable,\s*status: view\.status,\s*players,\s*canStart: !recoveryOnly && startOpen\(view\),\s*\}\)/,
    );
    expect(code).toMatch(/\{seatSummary\.text\}/);
    // A live region, so a screen-reader captain hears "All ten seated".
    expect(code).toMatch(/\{seatSummary \? \(\s*<p\s+role="status"\s+className=\{cn\(/);
    expect(code).toMatch(/seatSummary\.allSeated\s*\?/);
    // Start's highlight is the summary's `start`; Start itself still renders
    // only through startOpen (the guard below).
    expect(code).toMatch(/const startHighlighted = seatSummary\?\.start === true;/);
    expect(code).toMatch(
      /startHighlighted\s*\?\s*"ring-2 ring-success ring-offset-2 ring-offset-surface"\s*:\s*undefined/,
    );
    // Right above the buttons, so "All ten seated" sits beside Start.
    const summaryAt = code.indexOf("{seatSummary ? (");
    const buttonsAt = code.indexOf('<div className="flex flex-wrap gap-2">');
    expect(summaryAt).toBeGreaterThan(-1);
    expect(buttonsAt).toBeGreaterThan(summaryAt);
    expect(code.slice(summaryAt, buttonsAt)).not.toMatch(/<button/);
  });

  it("reports the viewer's own seat from the seat list it shows", () => {
    expect(code).toMatch(/const mySeat = viewerLobbySeat\(players\);/);
    expect(code).toMatch(
      /useEffect\(\(\) => \{\s*onViewerSeat\?\.\(mySeat\);\s*\}, \[mySeat, onViewerSeat\]\);/,
    );
    // A hook: before the early return, so it runs on every render.
    expect(code.indexOf("onViewerSeat?.(mySeat)")).toBeLessThan(
      code.indexOf("if (!lobbyPanelVisible(audience, availability)) return null;"),
    );
  });

  it("says what the bot does about the sides only in a ready in-house lobby or 1v1", () => {
    expect(code).toMatch(
      /\{kind !== "season" && state === "ready" && !releasing \? \(\s*<p className="text-xs text-muted">\{INHOUSE_SEAT_RULE_NOTE\}<\/p>/,
    );
  });
});

// SOURCE GUARD: Start renders only through startOpen, which hides it while a
// release is pending (the bot refuses to start a lobby it is leaving).
describe("DotaLobbyControls Start (source)", () => {
  const code = stripLineComments(
    sourceFile("src/components/dota-lobby-controls.tsx").text,
  );
  it("renders Start game with bot only through startOpen", () => {
    expect(code).toMatch(
      /\{!recoveryOnly && startOpen\(view\) \? \(\s*<button(?:(?!<\/button>)[^])*>\s*Start game with bot\s*<\/button>/,
    );
    expect(code.match(/Start game with bot/g)).toHaveLength(1);
  });
});

// SOURCE GUARD: a 1v1's panel (kind "duel") names its own game mode, never
// sends a joiner to "a captain", and is never hand-hosted: the copy that
// differs comes from the kind.
describe("DotaLobbyControls for a 1v1 (source)", () => {
  const code = stripLineComments(
    sourceFile("src/components/dota-lobby-controls.tsx").text,
  );
  it("heads the panel with 1v1 Solo Mid for a duel", () => {
    expect(code).toMatch(
      /\{duel \? DUEL_GAME_MODE\.name : LEAGUE_GAME_MODE\.name\}/,
    );
    expect(code).toMatch(/const duel = kind === "duel";/);
  });
  it("never tells a 1v1's viewer to wait for a captain", () => {
    expect(code).toMatch(
      /\{!duel && !view\.canControl && !busy && \["idle", "released"\]\.includes\(state\) \? \(/,
    );
  });
});

describe("DotaLobbyControls for a 1v1 (render)", () => {
  it("renders the hosts' panel for a duel on its first render", () => {
    const html = renderToStaticMarkup(
      createElement(DotaLobbyControls, { kind: "duel", id: "d1" }),
    );
    expect(html).toContain("Steam lobby bot");
    expect(html).toContain("1v1 Solo Mid");
    expect(html).not.toContain("Captains Mode");
  });
});
