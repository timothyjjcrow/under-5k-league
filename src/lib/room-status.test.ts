import { describe, expect, it } from "vitest";
import {
  DRAFT_ROOM_STATUS_COPY,
  INHOUSE_ROOM_STATUS_COPY,
  roomStatus,
  type RoomConnectivity,
} from "./room-status";

const healthy = {
  connectivity: "online" as RoomConnectivity,
  disconnected: false,
  actionReconciling: false,
  sessionExpired: false,
  syncDelayed: false,
};

describe("roomStatus", () => {
  it("shows nothing while the room is live and healthy", () => {
    expect(roomStatus(healthy, DRAFT_ROOM_STATUS_COPY)).toBeNull();
    expect(roomStatus(healthy, INHOUSE_ROOM_STATUS_COPY)).toBeNull();
  });

  it("picks exactly one condition, most important first", () => {
    const all = {
      connectivity: "offline" as RoomConnectivity,
      disconnected: true,
      actionReconciling: true,
      sessionExpired: true,
      syncDelayed: true,
    };
    const order = [
      ["offline", { connectivity: "offline" as RoomConnectivity }],
      ["disconnected", { connectivity: "resyncing" as RoomConnectivity }],
      ["resyncing", { disconnected: false }],
      ["reconciling", { connectivity: "online" as RoomConnectivity }],
      ["signed-out", { actionReconciling: false }],
      ["delayed", { sessionExpired: false }],
    ] as const;
    let input = { ...all };
    for (const [kind, change] of order) {
      input = { ...input, ...change };
      expect(roomStatus(input, DRAFT_ROOM_STATUS_COPY)?.kind).toBe(kind);
    }
    expect(roomStatus({ ...input, syncDelayed: false }, DRAFT_ROOM_STATUS_COPY)).toBeNull();
  });

  it("says a failing connection is lost, not restored, while polls still fail", () => {
    // Back online (resyncing) but the polls keep failing: the old strips
    // showed "restored" and "lost" at once.
    const status = roomStatus(
      { ...healthy, connectivity: "resyncing", disconnected: true },
      DRAFT_ROOM_STATUS_COPY,
    );
    expect(status?.kind).toBe("disconnected");
    expect(status?.text).toMatch(/^⚠️ Connection lost/);
  });

  it("marks stale-clock states for the compact bar and only those", () => {
    const short = (input: Partial<typeof healthy>) =>
      roomStatus({ ...healthy, ...input }, DRAFT_ROOM_STATUS_COPY)?.short;
    expect(short({ connectivity: "offline" })).toBe("⚠ offline");
    expect(short({ disconnected: true })).toBe("⚠ reconnecting…");
    expect(short({ connectivity: "resyncing" })).toBe("⚠ reconnecting…");
    expect(short({ actionReconciling: true })).toBeNull();
    expect(short({ sessionExpired: true })).toBeNull();
    expect(short({ syncDelayed: true })).toBeNull();
  });

  it("tones each condition", () => {
    const tone = (input: Partial<typeof healthy>) =>
      roomStatus({ ...healthy, ...input }, DRAFT_ROOM_STATUS_COPY)?.tone;
    expect(tone({ connectivity: "offline" })).toBe("danger");
    expect(tone({ disconnected: true })).toBe("danger");
    expect(tone({ connectivity: "resyncing" })).toBe("info");
    expect(tone({ actionReconciling: true })).toBe("info");
    expect(tone({ sessionExpired: true })).toBe("danger");
    expect(tone({ syncDelayed: true })).toBe("warning");
  });

  it("never raises a condition the room has no sentence for", () => {
    // The inhouse room tracks neither an expired sign-in nor a 429 strip.
    expect(
      roomStatus(
        { ...healthy, sessionExpired: true, syncDelayed: true },
        INHOUSE_ROOM_STATUS_COPY,
      ),
    ).toBeNull();
  });

  it("keeps each room's own nouns", () => {
    // These sentences are what the room-resilience browser specs look for.
    expect(
      roomStatus({ ...healthy, connectivity: "offline" }, DRAFT_ROOM_STATUS_COPY)
        ?.text,
    ).toMatch(/^⚠️ You're offline — the auction keeps running on the server/);
    expect(
      roomStatus(
        { ...healthy, connectivity: "offline" },
        INHOUSE_ROOM_STATUS_COPY,
      )?.text,
    ).toMatch(/^⚠️ You're offline — the queue and lobby keep running/);
    expect(
      roomStatus(
        { ...healthy, connectivity: "resyncing" },
        DRAFT_ROOM_STATUS_COPY,
      )?.text,
    ).toMatch(/^Connection restored — checking the current lot/);
    expect(
      roomStatus(
        { ...healthy, connectivity: "resyncing" },
        INHOUSE_ROOM_STATUS_COPY,
      )?.text,
    ).toMatch(/^Connection restored — checking the current queue and lobby/);
    expect(
      roomStatus(
        { ...healthy, actionReconciling: true },
        INHOUSE_ROOM_STATUS_COPY,
      )?.text,
    ).toMatch(/^Checking the current queue and lobby after an interrupted action/);
  });
});
