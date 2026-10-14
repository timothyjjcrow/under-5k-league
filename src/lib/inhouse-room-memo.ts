import type { BoardCheckMemo } from "./inhouse-room-due";

// The room poll's per-process memory (inhouse-room-state.ts). A leaf module
// with no runtime imports, so test/integration/setup.ts can reset it without
// loading the inhouse engine ahead of a test file's own vi.mock calls.

/**
 * This instance's board memo. Per process on purpose: each instance checks
 * once per change it sees, and the board's own digest and throttle settle
 * any overlap between instances.
 */
let boardMemo: BoardCheckMemo | null = null;

export function readRoomBoardMemo(): BoardCheckMemo | null {
  return boardMemo;
}

export function writeRoomBoardMemo(next: BoardCheckMemo): void {
  boardMemo = next;
}

/** Test-only: forget the room poll's memory (test/integration/setup.ts). */
export function resetInhouseRoomPollForTests(): void {
  boardMemo = null;
}
