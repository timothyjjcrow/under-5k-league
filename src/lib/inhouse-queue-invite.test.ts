import { describe, expect, it } from "vitest";
import {
  INHOUSE_QUEUE_INVITE_PATH,
  inhouseQueuePicturePath,
  inhouseQueuePreviewText,
  isInhouseQueueInvite,
} from "./inhouse-queue-invite";
import { signInHref } from "./sign-in";

describe("the inhouse queue invite link", () => {
  it("is the room's one-tap join", () => {
    expect(INHOUSE_QUEUE_INVITE_PATH).toBe("/inhouse?join=1");
    expect(isInhouseQueueInvite("1")).toBe(true);
    for (const other of [undefined, null, "", "0", "yes"]) {
      expect(isInhouseQueueInvite(other)).toBe(false);
    }
  });

  it("signs a visitor in back to itself, so they land in the queue", () => {
    expect(signInHref(INHOUSE_QUEUE_INVITE_PATH)).toBe(
      "/login?next=%2Finhouse%3Fjoin%3D1",
    );
  });
});

describe("inhouseQueuePreviewText", () => {
  const preview = (queued: number, liveGames = 0) =>
    inhouseQueuePreviewText({ queued, lobbySize: 10, liveGames });

  it("invites the first player into an empty queue", () => {
    expect(preview(0)).toEqual({
      title: "Join the inhouse queue",
      description:
        "The queue is open: be the first in. Open this link to join the queue in one tap. Ten in the queue start a game, and captains draft the teams.",
    });
  });

  it("says how full the queue is and how many more start a game", () => {
    expect(preview(4)).toEqual({
      title: "4/10 in the inhouse queue: join them",
      description:
        "6 more players start the game. Open this link to join the queue in one tap.",
    });
    expect(preview(9).description).toMatch(/^1 more player starts the game\./);
  });

  it("queues for the next game while one is live", () => {
    expect(preview(0, 1).title).toBe("An inhouse is live: queue for the next game");
    expect(preview(3, 2)).toEqual({
      title: "3/10 queued for the next inhouse",
      description:
        "2 inhouse games are live. 7 more players start the next game. Open this link to join the queue in one tap.",
    });
  });

  it("never asks for a negative number of players", () => {
    expect(preview(12, 2).description).toContain(
      "The queue is full: join now for the game after.",
    );
  });
});

describe("inhouseQueuePicturePath", () => {
  it("changes with the counts the picture shows", () => {
    expect(
      inhouseQueuePicturePath("opengraph-image", { queued: 4, liveGames: 1 }),
    ).toBe("/inhouse/queue/opengraph-image?v=4-1");
    expect(
      inhouseQueuePicturePath("twitter-image", { queued: 0, liveGames: 0 }),
    ).toBe("/inhouse/queue/twitter-image?v=0-0");
  });
});
