import { describe, expect, it } from "vitest";
import { sourceFile, sourceFiles } from "../../test/support/source-files";

// SOURCE GUARDS for the room poll (inhouse-room-state.ts). Its behaviour is
// tested in test/integration/inhouse-room-poll.itest.ts; these pin the shape
// no behavioural test can see:
//
// - the poll never runs a resolver itself. Maintenance goes only through
//   getInhouseState(runMaintenance: true) after winning the 2s claim, so the
//   resolver chain stays the one the parity guard checks;
// - the route's state branch hands the poll the session and claims nothing;
// - the resolvers and the due check decide with the same predicates.

/** Lines with code only: comments may quote what the code must not do. */
const code = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

/** One top-level function's text, from its declaration to the next one. */
function fn(src: string, name: string): string {
  const start = src.search(
    new RegExp(`\\n(export )?(async )?function ${name}\\b`),
  );
  if (start === -1) return "";
  const rest = src.slice(start + 1);
  const next = rest.search(/\n(export |async function |function |const |type )/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("the room poll's source", () => {
  // Every module of the poll: the pure rules, its memory and the poll itself.
  const poll = sourceFiles("src/lib/inhouse-room-*.ts", 3);

  it("never awaits a resolver in any of its modules", () => {
    for (const file of poll) {
      expect(
        [...code(file.text).matchAll(/await ((?:resolve|maybe)[A-Z]\w*)\(/g)].map(
          (m) => m[1],
        ),
        `${file.path} calls a resolver; maintenance runs only through getInhouseState`,
      ).toEqual([]);
    }
  });

  it("runs maintenance only through getInhouseState, after claiming the throttle", () => {
    const state = poll.find((f) => f.path === "src/lib/inhouse-room-state.ts");
    expect(state, "inhouse-room-state.ts moved; re-point this guard").toBeTruthy();
    const body = code(fn(state!.text, "pollInhouseState"));
    expect(body.length).toBeGreaterThan(0);
    const calls = [...body.matchAll(/getInhouseState\(/g)];
    expect(calls).toHaveLength(1);
    const call = body.indexOf("getInhouseState(");
    const claim = body.lastIndexOf("claimThrottle(", call);
    expect(claim, "getInhouseState must follow a claimThrottle(").toBeGreaterThan(-1);
    expect(body.slice(claim, call)).toContain("INHOUSE_ROOM_MAINTENANCE_AT");
    expect(body.slice(call, call + 200)).toMatch(/runMaintenance: true/);
    expect(body.slice(call, call + 200)).toMatch(/detectResults: false/);
    // The heartbeat goes through the one guarded writer, after its seam.
    const seam = body.indexOf('raceHook("inhouse.pollInhouseState.beforeHeartbeat")');
    const touch = body.indexOf("touchQueueHeartbeat(");
    expect(seam).toBeGreaterThan(-1);
    expect(touch).toBeGreaterThan(seam);
    // The 1v1 queue heartbeat too: through its one guarded writer, after its
    // own seam, and after the 5v5's.
    const duelSeam = body.indexOf('raceHook("inhouse.pollInhouseState.beforeDuelHeartbeat")');
    const duelTouch = body.indexOf("touchDuelQueueHeartbeat(");
    expect(duelSeam).toBeGreaterThan(touch);
    expect(duelTouch).toBeGreaterThan(duelSeam);
    expect(body.slice(0, duelTouch)).toMatch(/duelHeartbeatAction\(/);
    // No write of its own to the inhouse tables, the 1v1's included.
    for (const file of poll) {
      expect(code(file.text)).not.toMatch(
        /\.(inhouseQueueEntry|inhouseLobby|inhouseLobbyPlayer|inhouseDuelQueueEntry|inhouseDuel)\.(update|updateMany|create|createMany|upsert|delete|deleteMany)\(/,
      );
    }
  });

  it("the route's state branch polls and claims nothing itself", () => {
    const route = code(sourceFile("src/app/api/inhouse/route.ts").text);
    const branch = route.slice(
      route.indexOf('if (action === "state")'),
      route.indexOf("requireSameOrigin(req)"),
    );
    // The session and the room version, read side by side, then the poll.
    expect(branch).toMatch(
      /Promise\.all\(\[\s*getSessionUser\(\),\s*readInhouseRoomVersion\(\),\s*\]\)/,
    );
    expect(branch).toContain("pollInhouseState(user, version)");
    expect(branch).not.toContain("publishInhouseRoomChange(");
    expect(branch).not.toContain("claimThrottle(");
    expect(branch).not.toContain("getInhouseState(");
    expect(route).not.toContain("claimThrottle(");
  });

  it("the route holds a request only before it polls, then reads the session and version again", () => {
    const route = code(sourceFile("src/app/api/inhouse/route.ts").text);
    const branch = route.slice(
      route.indexOf('if (action === "state")'),
      route.indexOf("requireSameOrigin(req)"),
    );
    const read = /Promise\.all\(\[\s*getSessionUser\(\),\s*readInhouseRoomVersion\(\),\s*\]\)/g;
    const reads = [...branch.matchAll(read)].map((m) => m.index!);
    expect(reads).toHaveLength(2);
    const mark = branch.indexOf("inhouseRoomHoldMark()");
    const hold = branch.indexOf("holdInhouseRoomPoll(");
    const poll = branch.indexOf("pollInhouseState(user, version)");
    // The hold mark before the first read (a racing publish re-checks the
    // hold), the hold between the reads, the poll after both.
    expect(mark).toBeGreaterThan(-1);
    expect(mark).toBeLessThan(reads[0]);
    expect(hold).toBeGreaterThan(reads[0]);
    expect(reads[1]).toBeGreaterThan(hold);
    expect(poll).toBeGreaterThan(reads[1]);
    // Only a client that shows the version just read is held, never while
    // the process is stopping, and the reply says whether it was (the client
    // backs off a churning version, or a stopping slot).
    expect(branch).toMatch(
      /const held =\s*hold !== null &&\s*hold\.since === inhouseRoomVersionToken\(version\) &&\s*!inhouseRoomShuttingDown\(\);\s*if \(hold && held\) \{/,
    );
    expect(branch).toMatch(/roomVersion: inhouseRoomVersionToken\(version\),\s*held,/);
    // A client that went away gets no poll.
    expect(branch.slice(hold, reads[1])).toMatch(
      /if \(wake === "aborted"\) return new NextResponse\(null, \{ status: 204 \}\);/,
    );
    // The reply names the version read before its rows.
    expect(branch).toMatch(/roomVersion: inhouseRoomVersionToken\(version\)/);
  });

  it("the hold counts clocks from the shown reply, and wakes for the viewer's board retry and banner", () => {
    const state = code(sourceFile("src/lib/inhouse-room-state.ts").text);
    const body = fn(state, "holdInhouseRoomPoll");
    const wake = body.slice(body.indexOf("inhouseRoomWakeAt("), body.indexOf("const holdMs"));
    expect(wake.length).toBeGreaterThan(0);
    expect(wake).toMatch(/maintains: o\.viewer !== null/);
    expect(wake).toMatch(/fromMs: o\.hold\.sinceNowMs/);
    expect(wake).toMatch(/viewerId: o\.viewer\?\.id \?\? null/);
    // A throttled board edit's retry, for a signed-in viewer, only where
    // Discord may be changed (signed-out polls never check the board).
    expect(wake).toMatch(
      /boardRetryAtMs:\s*o\.viewer !== null && discordMutationsAllowed\(\)\s*\?\s*boardRetryAtMs\(readRoomBoardMemo\(\)\)\s*:\s*null/,
    );
    // A clock already run out answers before anything is held.
    expect(body).toMatch(/if \(clockAt !== null && clockAt <= nowMs\) return "deadline";/);
    expect(body.indexOf('return "deadline"')).toBeLessThan(
      body.indexOf("waitForInhouseRoomChange("),
    );
  });

  it("the hold reads only the snapshot and writes nothing", () => {
    const state = code(sourceFile("src/lib/inhouse-room-state.ts").text);
    const body = fn(state, "holdInhouseRoomPoll");
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("roomCache.get(o.version)");
    expect(body).toContain("waitForInhouseRoomChange(");
    for (const forbidden of [
      "touchQueueHeartbeat(",
      "touchDuelQueueHeartbeat(",
      "claimThrottle(",
      "publishInhouseRoomChange(",
      "getInhouseState(",
      "syncInhouseBoard(",
      "loadViewerExtras(",
    ]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });

  it("the resolvers decide with the due check's predicates", () => {
    const service = code(sourceFile("src/lib/inhouse-service.ts").text);
    const expectations: [string, string[]][] = [
      ["resolveReadyCheck", ["inhouseAllAccepted(", "inhouseClockDue("]],
      ["resolveCaptainVote", ["inhouseAllVoted(", "inhouseClockDue("]],
      ["resolveStalledPick", ["inhouseDraftPool(", "inhouseClockDue("]],
    ];
    for (const [name, calls] of expectations) {
      const body = fn(service, name);
      expect(body.length, `${name} not found`).toBeGreaterThan(0);
      for (const call of calls) expect(body, `${name} → ${call}`).toContain(call);
    }
  });
});
