import { describe, expect, it } from "vitest";
import {
  botGameOverRefusal,
  botHoldsUnlaunchedLobby,
  createOpen,
  inviteResultToast,
  inviteUnknownToast,
  LOBBY_INVITES,
  LOBBY_OVER_NOTE,
  LOBBY_PANEL_POLL_MS,
  LOBBY_PANEL_STARTED_POLL_MS,
  LOBBY_RECOVERY_POLL_MS,
  LOBBY_SEATS,
  lobbyBusyElsewhere,
  lobbyBusyLabel,
  lobbyBusyNote,
  lobbyInviteScope,
  lobbyListVisible,
  lobbyPanelPollMs,
  lobbyPlayerRow,
  lobbyStatusLabel,
  noPopupHelp,
  lobbyPlayerViews,
  parseBotPlayers,
  parseInvitedCount,
  parseLobbyDigits,
  parseLobbyLifecycle,
  reinviteMissingOpen,
  releaseOpen,
  selfInviteOpen,
  startOpen,
  type DotaLobbyPlayerView,
  type DotaLobbyStatus,
  type LobbyInvite,
  type LobbyInviteScope,
  type LobbyRosterEntry,
  type LobbySeat,
} from "./dota-lobby";

describe("lobbyPanelPollMs", () => {
  // Every state the bot reports, with the panel's refresh for it.
  const cases = {
    idle: null,
    creating: LOBBY_PANEL_POLL_MS,
    ready: LOBBY_PANEL_POLL_MS,
    starting: LOBBY_PANEL_POLL_MS,
    started: LOBBY_PANEL_STARTED_POLL_MS,
    blocked: LOBBY_PANEL_POLL_MS,
    released: null,
  } satisfies Record<DotaLobbyStatus["state"], number | null>;

  it.each(Object.entries(cases))(
    "%s refreshes every %s ms once the game is over",
    (state, every) => {
      expect(lobbyPanelPollMs(state as DotaLobbyStatus["state"], false)).toBe(
        every,
      );
    },
  );

  // 2026-10-17: a captain pressed Create, and every other panel (the other
  // captain's, the admins', the players') stayed on "No bot lobby yet" until
  // the game started, so nobody else saw the seats, the invites or Start.
  it.each(["idle", "released"] as const)(
    "keeps reading a playable game with no bot lobby (%s) at the setup rate",
    (state) => {
      expect(lobbyPanelPollMs(state, true)).toBe(LOBBY_PANEL_POLL_MS);
    },
  );

  it.each(Object.entries(cases).filter(([, every]) => every !== null))(
    "reads %s at the same rate whether or not the game is playable",
    (state, every) => {
      expect(lobbyPanelPollMs(state as DotaLobbyStatus["state"], true)).toBe(
        every,
      );
    },
  );

  it("does not refresh while the first read is still out", () => {
    expect(lobbyPanelPollMs(undefined, true)).toBeNull();
    expect(lobbyPanelPollMs(undefined, false)).toBeNull();
  });

  // A panel whose first read failed (a bot restarting refuses connections
  // for half a minute) used to show the failure until someone pressed
  // "Refresh bot status".
  it("retries a failed first read at the running-game rate", () => {
    for (const playable of [true, false])
      expect(lobbyPanelPollMs(undefined, playable, false, true)).toBe(
        LOBBY_PANEL_STARTED_POLL_MS,
      );
    expect(lobbyPanelPollMs(undefined, true, true, true)).toBeNull();
    // Once the bot answered, its state decides, whatever failed before.
    expect(lobbyPanelPollMs("ready", true, false, true)).toBe(LOBBY_PANEL_POLL_MS);
    expect(lobbyPanelPollMs("released", false, false, true)).toBeNull();
  });

  // Dota showed the game over: the site marks it over and the panel has
  // nothing left to wait for, whatever the state or the game.
  it.each(Object.keys(cases))("stops reading a game Dota showed over (%s)", (state) => {
    for (const playable of [true, false])
      expect(
        lobbyPanelPollMs(state as DotaLobbyStatus["state"], playable, true),
      ).toBeNull();
  });

  // The rates Tim asked for on the box (2026-10-18): 3s while a lobby is set
  // up or awaited (every panel of a game shares one bot read), 15s through a
  // running game, fast enough to show its end and a pending release.
  it("reads setup every 3 seconds and a running game every 15", () => {
    expect(LOBBY_PANEL_POLL_MS).toBe(3_000);
    expect(LOBBY_PANEL_STARTED_POLL_MS).toBe(15_000);
    expect(LOBBY_RECOVERY_POLL_MS).toBe(15_000);
  });
});

describe("parseLobbyLifecycle", () => {
  it("keeps only a boolean true for each flag", () => {
    expect(parseLobbyLifecycle({ releasing: true, over: true })).toEqual({
      releasing: true,
      over: true,
    });
    expect(parseLobbyLifecycle({ releasing: true })).toEqual({ releasing: true });
    expect(parseLobbyLifecycle({ over: true })).toEqual({ over: true });
    expect(parseLobbyLifecycle({})).toEqual({});
  });

  it.each([false, "true", 1, null, {}, [true]])(
    "reads %j as unknown, so absent",
    (value) => {
      expect(parseLobbyLifecycle({ releasing: value, over: value })).toEqual({});
    },
  );
});

describe("parseLobbyDigits", () => {
  it("keeps Valve's digit ids", () => {
    for (const id of ["1", "30007027938516500", "9050201642", "1".repeat(20)])
      expect(parseLobbyDigits(id)).toBe(id);
  });

  it.each(["", "0", "012", "1".repeat(21), "12a", " 12", "-1", "1e5"])(
    "drops %j",
    (id) => {
      expect(parseLobbyDigits(id)).toBeUndefined();
    },
  );

  it.each([123, null, undefined, {}, ["1"]])("drops a non-string %j", (id) => {
    expect(parseLobbyDigits(id)).toBeUndefined();
  });
});

describe("the panel's lifecycle wording and controls", () => {
  it("shows the seat list while the lobby is ready and while Dota starts the game", () => {
    const shown = (Object.keys(LOBBY_STATES) as DotaLobbyStatus["state"][]).filter(
      lobbyListVisible,
    );
    expect(shown).toEqual(["ready", "starting"]);
    expect(lobbyListVisible(undefined)).toBe(false);
  });

  it("says a pending release before anything else, then a game Dota showed over", () => {
    for (const state of Object.keys(LOBBY_STATES) as DotaLobbyStatus["state"][]) {
      expect(lobbyStatusLabel({ state, releasing: true, over: true })).toBe(
        "Leaving the Dota lobby…",
      );
      expect(lobbyStatusLabel({ state, over: true })).toBe("Game over in Dota");
      expect(lobbyStatusLabel({ state })).toBe(LOBBY_STATES[state]);
    }
    expect(LOBBY_OVER_NOTE).toBe(
      "Game over in Dota — the result records itself from OpenDota.",
    );
  });

  it("offers Release while the bot holds a lobby, never twice while one is pending", () => {
    const open = (
      state: DotaLobbyStatus["state"],
      extra: { releasing?: true; canRelease?: boolean } = {},
    ) =>
      releaseOpen({
        canRelease: extra.canRelease ?? true,
        status: { state, ...(extra.releasing ? { releasing: true } : {}) },
      });
    const offered = (Object.keys(LOBBY_STATES) as DotaLobbyStatus["state"][]).filter(
      (state) => open(state),
    );
    expect(offered).toEqual(["ready", "started", "blocked"]);
    for (const state of offered) {
      expect(open(state, { releasing: true })).toBe(false);
      expect(open(state, { canRelease: false })).toBe(false);
    }
  });

  // Once Dota shows the game over the bot leaves at the postgame by itself,
  // and a release after that answers STATE ("This lobby cannot perform that
  // action"): no button for it.
  it("never offers Release once Dota showed the game over", () => {
    expect(
      releaseOpen({ canRelease: true, status: { state: "started", over: true } }),
    ).toBe(false);
    expect(releaseOpen({ canRelease: true, status: { state: "started" } })).toBe(true);
  });

  // The bot refuses Start on a lobby it is leaving (STATE), so the button
  // must not show while a release is pending.
  it("offers Start to a captain or admin on a ready lobby, never while a release is pending", () => {
    const open = (
      state: DotaLobbyStatus["state"],
      extra: { releasing?: true; canControl?: boolean } = {},
    ) =>
      startOpen({
        canControl: extra.canControl ?? true,
        status: { state, ...(extra.releasing ? { releasing: true } : {}) },
      });
    expect(
      (Object.keys(LOBBY_STATES) as DotaLobbyStatus["state"][]).filter((state) => open(state)),
    ).toEqual(["ready"]);
    expect(open("ready", { releasing: true })).toBe(false);
    expect(open("ready", { canControl: false })).toBe(false);
  });
});

// 2026-10-18 review: one bot hosts one game at a time, so on a two-game night
// game 2's panel must say the bot is game 1's and send it to the by-hand steps.
describe("the bot hosting another game", () => {
  const live = { game: "#4110", closed: false };
  const closed = { game: "#4110", closed: true };
  const view = (
    state: DotaLobbyStatus["state"],
    busyElsewhere?: { game: string | null; closed: boolean },
    canControl = true,
  ) => ({ canControl, status: { state }, ...(busyElsewhere ? { busyElsewhere } : {}) });

  it("counts only while this game's own job has no lobby", () => {
    for (const state of Object.keys(LOBBY_STATES) as DotaLobbyStatus["state"][]) {
      const busy = lobbyBusyElsewhere(view(state, live));
      expect(busy, state).toEqual(state === "idle" || state === "released" ? live : null);
    }
    expect(lobbyBusyElsewhere(view("idle"))).toBeNull();
  });

  it("names the game, or another game when it isn't this league's in-house game", () => {
    expect(lobbyBusyLabel(live)).toBe("The bot is hosting game #4110");
    expect(lobbyBusyLabel(closed)).toBe("The bot is still leaving finished game #4110");
    expect(lobbyBusyLabel({ game: null, closed: false })).toBe("The bot is hosting another game");
  });

  it("sends a game still being played to the by-hand steps, and a closed one to Create", () => {
    expect(lobbyBusyNote(live, true)).toMatch(/Host this game by hand/);
    expect(lobbyBusyNote(live, false)).toMatch(/Host this game by hand/);
    expect(lobbyBusyNote(closed, true)).toMatch(/^Press “Create Dota lobby”/);
    expect(lobbyBusyNote(closed, false)).toMatch(/A captain's “Create Dota lobby”/);
  });

  it("offers Create only where it would work", () => {
    expect(createOpen(view("idle"))).toBe(true);
    expect(createOpen(view("released"))).toBe(true);
    // A game still being played keeps the bot: Create would only answer BUSY.
    expect(createOpen(view("idle", live))).toBe(false);
    // A closed game's hold: Create frees the bot from it first.
    expect(createOpen(view("idle", closed))).toBe(true);
    expect(createOpen(view("idle", undefined, false))).toBe(false);
    for (const state of ["creating", "ready", "starting", "started", "blocked"] as const)
      expect(createOpen(view(state)), state).toBe(false);
  });
});

/** Every bot state with its panel label, in the bot's order. */
const LOBBY_STATES = {
  idle: "No bot lobby yet",
  creating: "Creating lobby…",
  ready: "Lobby ready",
  starting: "Dota is starting the game…",
  started: "Game started",
  blocked: "Lobby needs attention",
  released: "Bot released",
} as const satisfies Record<DotaLobbyStatus["state"], string>;

describe("botHoldsUnlaunchedLobby", () => {
  // Every state the bot reports, each with its answer. `satisfies` makes a new
  // state a compile error here until someone decides whether it blocks
  // "Game over".
  const HOLDS = {
    idle: false,
    creating: true,
    ready: true,
    starting: true,
    started: false,
    // Also what an offline bot reports; its Release can't work then either.
    blocked: false,
    released: false,
  } as const satisfies Record<DotaLobbyStatus["state"], boolean>;

  it("blocks Game over while the bot holds a lobby it has not launched", () => {
    for (const [state, holds] of Object.entries(HOLDS)) {
      expect(
        botHoldsUnlaunchedLobby({ state: state as DotaLobbyStatus["state"] }),
        state,
      ).toBe(holds);
    }
  });

  it("lets a launched game through: the bot has already let the lobby go", () => {
    expect(
      botHoldsUnlaunchedLobby({
        state: "started",
        lobbyId: "123",
        matchId: "8123456789",
      }),
    ).toBe(false);
  });

  it("never blocks on an unknown answer (no bot, unreachable, not its game)", () => {
    expect(botHoldsUnlaunchedLobby(null)).toBe(false);
  });

  it("reads only the state, never the message", () => {
    expect(
      botHoldsUnlaunchedLobby({ state: "idle", message: "creating" }),
    ).toBe(false);
    expect(
      botHoldsUnlaunchedLobby({ state: "ready", message: "released" }),
    ).toBe(true);
  });

  // The bot is already leaving: its Start and invites refuse and the panel
  // hides Release, so a refusal naming them would point at nothing.
  it("lets a pending release through, whatever the state", () => {
    for (const state of Object.keys(HOLDS) as DotaLobbyStatus["state"][])
      expect(botHoldsUnlaunchedLobby({ state, releasing: true }), state).toBe(false);
  });
});

describe("botGameOverRefusal", () => {
  it("names the panel's two buttons only for a ready lobby, where both show", () => {
    expect(botGameOverRefusal({ state: "ready" })).toBe(
      "The lobby bot is still holding this game's Dota lobby. A captain can press “Start game with bot” or “Release bot…” in the bot panel, then mark the game over.",
    );
    // Neither button shows while the bot creates or starts the lobby.
    for (const state of ["creating", "starting"] as const)
      expect(botGameOverRefusal({ state }), state).toBe(
        "The lobby bot is still setting up or starting this game's Dota lobby. Try again in a minute.",
      );
  });

  it("refuses nothing the bot doesn't hold", () => {
    expect(botGameOverRefusal(null)).toBeNull();
    for (const state of ["idle", "started", "blocked", "released"] as const)
      expect(botGameOverRefusal({ state }), state).toBeNull();
    expect(botGameOverRefusal({ state: "ready", releasing: true })).toBeNull();
  });
});

const RADIANT_ID = "76561198000000001";
const DIRE_ID = "76561198000000002";

describe("parseBotPlayers", () => {
  const good = [
    { id: RADIANT_ID, seat: "radiant", invite: "sent" },
    { id: DIRE_ID, seat: "absent", invite: "offline" },
  ];

  it("reads the bot's list exactly as the contract shapes it", () => {
    expect(parseBotPlayers(good)).toEqual(good);
    expect(parseBotPlayers([])).toEqual([]);
    for (const seat of LOBBY_SEATS)
      for (const invite of LOBBY_INVITES)
        expect(parseBotPlayers([{ id: RADIANT_ID, seat, invite }])).toEqual([
          { id: RADIANT_ID, seat, invite },
        ]);
  });

  // Anything off-contract is unknown (no list), never "not invited".
  it.each<[string, unknown]>([
    ["missing", undefined],
    ["null", null],
    ["an object", { players: good }],
    ["a string", JSON.stringify(good)],
    ["more than twenty", Array.from({ length: 21 }, (_, i) => ({ id: `765611980000000${String(i).padStart(2, "0")}`, seat: "absent", invite: "none" }))],
    ["a null entry", [good[0], null]],
    ["an array entry", [good[0], [DIRE_ID, "absent", "none"]]],
    ["an extra key", [{ ...good[0], steamId: RADIANT_ID }]],
    ["a missing key", [{ id: RADIANT_ID, seat: "radiant" }]],
    ["a numeric id", [{ ...good[0], id: 76561198000000001 }]],
    ["a short id", [{ ...good[0], id: "7656119800000000" }]],
    ["a long id", [{ ...good[0], id: "765611980000000011" }]],
    ["a padded id", [{ ...good[0], id: ` ${RADIANT_ID}` }]],
    ["an unknown seat", [{ ...good[0], seat: "spectator" }]],
    ["an unknown invite", [{ ...good[0], invite: "blocked" }]],
    ["a repeated id", [good[0], { ...good[1], id: RADIANT_ID }]],
  ])("treats %s as unknown", (_, value) => {
    expect(parseBotPlayers(value)).toBeUndefined();
  });
});

describe("parseInvitedCount", () => {
  it("reads an integer from 0 to 20", () => {
    for (const n of [0, 1, 10, 20]) expect(parseInvitedCount(n)).toBe(n);
  });
  it.each([undefined, null, -1, 21, 1.5, "3", Number.NaN, Infinity])(
    "treats %s as unknown",
    (value) => expect(parseInvitedCount(value)).toBeUndefined(),
  );
});

describe("lobbyPlayerViews", () => {
  const roster: LobbyRosterEntry[] = [
    { name: "Rad", side: "radiant", steamId: RADIANT_ID, self: false },
    { name: "Me", side: "dire", steamId: DIRE_ID, self: true },
  ];

  it("maps each roster player onto the bot's seat, with no Steam id", () => {
    const views = lobbyPlayerViews(roster, [
      { id: DIRE_ID, seat: "unassigned", invite: "sent" },
      { id: RADIANT_ID, seat: "radiant", invite: "none" },
    ]);
    expect(views).toEqual([
      { name: "Rad", side: "radiant", seat: "radiant", invite: "none", self: false },
      { name: "Me", side: "dire", seat: "unassigned", invite: "sent", self: true },
    ]);
    expect(JSON.stringify(views)).not.toMatch(/7656119/);
  });

  it("is unknown when the bot's list isn't the roster id for id", () => {
    expect(lobbyPlayerViews(roster, undefined)).toBeUndefined();
    expect(lobbyPlayerViews([], [])).toBeUndefined();
    // Someone missing from the bot's list.
    expect(
      lobbyPlayerViews(roster, [{ id: RADIANT_ID, seat: "radiant", invite: "none" }]),
    ).toBeUndefined();
    // Someone the roster doesn't have.
    expect(
      lobbyPlayerViews(roster, [
        { id: RADIANT_ID, seat: "radiant", invite: "none" },
        { id: DIRE_ID, seat: "dire", invite: "none" },
        { id: "76561198000000003", seat: "dire", invite: "none" },
      ]),
    ).toBeUndefined();
    // The same length, one id swapped: a create-time roster after a stand-in.
    expect(
      lobbyPlayerViews(roster, [
        { id: RADIANT_ID, seat: "radiant", invite: "none" },
        { id: "76561198000000003", seat: "dire", invite: "none" },
      ]),
    ).toBeUndefined();
    // The same id twice.
    expect(
      lobbyPlayerViews(roster, [
        { id: RADIANT_ID, seat: "radiant", invite: "none" },
        { id: RADIANT_ID, seat: "dire", invite: "none" },
      ]),
    ).toBeUndefined();
  });
});

describe("lobbyInviteScope", () => {
  it("lets a captain or admin invite everyone missing, a rostered player only themselves", () => {
    const scope = (canControl: boolean, playable: boolean, rostered: boolean) =>
      lobbyInviteScope({ canControl, playable, rostered });
    expect(scope(true, true, false)).toBe("missing");
    expect(scope(true, true, true)).toBe("missing");
    expect(scope(false, true, true)).toBe("self");
    expect(scope(false, true, false)).toBeNull();
    // A game that isn't playable invites nobody.
    for (const canControl of [true, false])
      for (const rostered of [true, false])
        expect(scope(canControl, false, rostered)).toBeNull();
  });
});

describe("the invite buttons", () => {
  const STATES = [
    "idle",
    "creating",
    "ready",
    "starting",
    "started",
    "blocked",
    "released",
  ] as const satisfies readonly DotaLobbyStatus["state"][];
  const row = (seat: LobbySeat, self = false): DotaLobbyPlayerView => ({
    name: self ? "Me" : "Them",
    side: "radiant",
    seat,
    invite: "sent",
    self,
  });
  const view = (
    inviteScope: LobbyInviteScope | null,
    state: DotaLobbyStatus["state"],
    players?: DotaLobbyPlayerView[],
  ) => ({ inviteScope, status: { state }, players });

  it("offers Re-invite to captains and admins while the lobby is ready and someone is missing", () => {
    const missing = [row("radiant", true), row("absent")];
    for (const state of STATES)
      expect(reinviteMissingOpen(view("missing", state, missing)), state).toBe(
        state === "ready",
      );
    expect(reinviteMissingOpen(view("missing", "ready", [row("radiant"), row("unassigned")]))).toBe(false);
    // No list (an older bot) or another scope: no button.
    expect(reinviteMissingOpen(view("missing", "ready"))).toBe(false);
    expect(reinviteMissingOpen(view("self", "ready", missing))).toBe(false);
    expect(reinviteMissingOpen(view(null, "ready", missing))).toBe(false);
  });

  it("offers Send me an invite to a rostered player whose own row is absent", () => {
    const meMissing = [row("absent", true), row("radiant")];
    for (const state of STATES)
      expect(selfInviteOpen(view("self", state, meMissing)), state).toBe(
        state === "ready",
      );
    // Someone else missing, but not me.
    expect(selfInviteOpen(view("self", "ready", [row("unassigned", true), row("absent")]))).toBe(false);
    expect(selfInviteOpen(view("self", "ready"))).toBe(false);
    // Captains and admins get Re-invite instead.
    expect(selfInviteOpen(view("missing", "ready", meMissing))).toBe(false);
    expect(selfInviteOpen(view(null, "ready", meMissing))).toBe(false);
  });

  // The bot refuses invites into a lobby it is leaving (STATE).
  it("offers neither invite while a release is pending", () => {
    const leaving = (scope: LobbyInviteScope, players: DotaLobbyPlayerView[]) => ({
      inviteScope: scope,
      status: { state: "ready" as const, releasing: true as const },
      players,
    });
    expect(reinviteMissingOpen(leaving("missing", [row("radiant", true), row("absent")]))).toBe(false);
    expect(selfInviteOpen(leaving("self", [row("absent", true), row("radiant")]))).toBe(false);
  });
});

describe("lobbyPlayerRow", () => {
  // Every seat and invite for a Radiant player, in Dota's side names (what
  // the lobby shows). `satisfies` makes a new seat or invite a compile error
  // here until its row text is decided.
  const RADIANT_PLAYER = {
    radiant: {
      none: "On Radiant",
      sent: "On Radiant",
      offline: "On Radiant",
      failed: "On Radiant",
    },
    dire: {
      none: "On Dire: belongs on Radiant",
      sent: "On Dire: belongs on Radiant",
      offline: "On Dire: belongs on Radiant",
      failed: "On Dire: belongs on Radiant",
    },
    unassigned: {
      none: "In the lobby: needs a Radiant slot",
      sent: "In the lobby: needs a Radiant slot",
      offline: "In the lobby: needs a Radiant slot",
      failed: "In the lobby: needs a Radiant slot",
    },
    absent: {
      none: "Not invited yet",
      sent: "Invite sent",
      offline: "Invite waiting: pops up when they open Dota",
      failed: "Invite didn't send",
    },
  } as const satisfies Record<LobbySeat, Record<LobbyInvite, string>>;

  it("words every seat and invite against the player's own side", () => {
    for (const [seat, invites] of Object.entries(RADIANT_PLAYER))
      for (const [invite, text] of Object.entries(invites)) {
        const result = lobbyPlayerRow({
          side: "radiant",
          seat: seat as LobbySeat,
          invite: invite as LobbyInvite,
          self: false,
        });
        expect(result, `${seat}/${invite}`).toEqual({
          text,
          settled: seat === "radiant",
        });
      }
  });

  it("names the other side for a Dire player", () => {
    const dire = (seat: LobbySeat) =>
      lobbyPlayerRow({ side: "dire", seat, invite: "none", self: false });
    expect(dire("dire")).toEqual({ text: "On Dire", settled: true });
    expect(dire("radiant")).toEqual({
      text: "On Radiant: belongs on Dire",
      settled: false,
    });
    expect(dire("unassigned").text).toBe("In the lobby: needs a Dire slot");
  });

  it("speaks to the viewer on their own waiting invite", () => {
    expect(
      lobbyPlayerRow({ side: "radiant", seat: "absent", invite: "offline", self: true })
        .text,
    ).toBe("Invite waiting: pops up when you open Dota");
  });
});

describe("noPopupHelp", () => {
  it("names the button this viewer has for a new invite, or a captain", () => {
    expect(noPopupHelp("self")).toContain("then press Send me an invite");
    expect(noPopupHelp("missing")).toContain("then press Re-invite missing players");
    expect(noPopupHelp(null)).toContain("then ask a captain to re-invite you");
    for (const scope of ["self", "missing", null] as const) {
      expect(noPopupHelp(scope)).toContain("“Block party invites from non-friends”");
      expect(noPopupHelp(scope)).toContain("Play → Custom Lobbies");
    }
  });
});

describe("invite toasts", () => {
  const absent = { seat: "absent", self: false } as const;
  const seated = { seat: "radiant", self: false } as const;
  const meAbsent = { seat: "absent", self: true } as const;
  const meSeated = { seat: "unassigned", self: true } as const;

  it("counts the invites sent", () => {
    expect(
      inviteResultToast({ scope: "missing", invited: 3, players: [absent] }),
    ).toEqual({
      type: "success",
      message: "Sent 3 invites. Each player accepts theirs in Dota.",
    });
    expect(
      inviteResultToast({ scope: "missing", invited: 1, players: [absent] })
        .message,
    ).toBe("Sent 1 invite. Each player accepts theirs in Dota.");
    expect(
      inviteResultToast({ scope: "self", invited: 1, players: [meAbsent] }),
    ).toEqual({
      type: "success",
      message: "Invite sent. Accept it in Dota, then take a slot on your side.",
    });
  });

  it("says everyone is in when nothing was sent and nobody is missing", () => {
    expect(
      inviteResultToast({ scope: "missing", invited: 0, players: [seated, meSeated] }),
    ).toEqual({ type: "info", message: "Everyone is already in the lobby." });
    // Someone else missing doesn't matter to my own invite.
    expect(
      inviteResultToast({ scope: "self", invited: 0, players: [meSeated, absent] }),
    ).toEqual({ type: "info", message: "You're already in the lobby." });
  });

  it("says the invites already went out when nothing was sent but someone is missing", () => {
    for (const players of [[seated, absent], undefined]) {
      const toast = inviteResultToast({ scope: "missing", invited: 0, players });
      expect(toast.type).toBe("info");
      expect(toast.message).toMatch(/^No new invites: .*last 30 seconds/);
    }
    expect(
      inviteResultToast({ scope: "self", invited: 0, players: [meAbsent] })
        .message,
    ).toMatch(/^No new invite: you had one in the last 30 seconds/);
  });

  it("treats a lost or unreadable answer as unknown, never failed", () => {
    expect(inviteUnknownToast("missing")).toBe(
      "The invites may have gone out. Check the list before sending again.",
    );
    expect(inviteUnknownToast("self")).toBe(
      "Your invite may have gone out. Check the list before asking again.",
    );
    for (const scope of ["missing", "self"] as const)
      expect(
        inviteResultToast({ scope, invited: undefined, players: undefined }),
      ).toEqual({ type: "info", message: inviteUnknownToast(scope) });
  });
});
