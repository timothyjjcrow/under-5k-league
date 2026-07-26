import { INHOUSE_STATUS } from "./constants";

// The live inhouse queue board: ONE Discord message the site rewrites in place
// instead of posting a new "6/10 queued" line every time somebody joins.
//
// Everything here is pure — no DB, no fetch — so every state below is a table
// test. The service (inhouse-board-service.ts) owns the message id, the
// throttle claim and the PATCH; this file only answers "what should the board
// say right now, and has that changed?".
//
// The DIGEST is the cost model. It hashes the SEMANTIC state only (phase,
// counts, who's in) and deliberately EXCLUDES the clock — that exclusion is
// what stops a motionless queue from burning one edit per throttle window
// forever. Anything time-varying in the digest turns this feature into a
// permanent 6-edits-per-minute drip on an empty queue: keep wall-clock time
// out of it, and render elapsed time with Discord's own <t:…:R> markup, which
// keeps counting in every client with no further edits from us.

export type BoardLobby = {
  status: string;
  /** READY_CHECK only: how many of the ten have pressed accept. */
  acceptedCount: number;
  playerCount: number;
  /** Epoch ms the game was marked started (IN_PROGRESS), else null. */
  startedAtMs: number | null;
};

export type BoardSnapshot = {
  /** Present queue entries in join order. While a lobby is up these are the
   *  players waiting for the NEXT game, not the ten who are playing. */
  presentNames: string[];
  /** Entries whose heartbeat went quiet — listed on site, never counted. */
  awayCount: number;
  lobbySize: number;
  lobby: BoardLobby | null;
  siteUrl: string;
  nowMs: number;
};

export type BoardEmbed = {
  title: string;
  url: string;
  description: string;
  color: number;
};

export type BoardRender = { digest: string; embed: BoardEmbed };

const COLOR = {
  IDLE: 0x4b5563, // slate — the resting state, ~95% of the time
  FILLING: 0x3b82f6, // blue
  CLOSE: 0xf59e0b, // amber — two or fewer to go
  LOBBY: 0x8b5cf6, // violet — ready check / vote / draft
  LIVE: 0x22c55e, // green — game in progress
} as const;

/** Longest a single player name may occupy on the board. */
const NAME_MAX = 32;
/** Names listed inline before we collapse the tail into "+N more". */
const NAMES_SHOWN = 12;

/**
 * Neutralise Discord markdown in player-supplied text (Steam personas, which
 * the player controls). Higher stakes here than in a transient announcement:
 * this message is pinned and never scrolls away, so a persona of `**` or a
 * `[label](evil.link)` would deface the channel permanently. Escaping `<`/`>`
 * additionally stops a persona forging a fake <t:…> timestamp or a <@id> that
 * LOOKS like a mention (allowed_mentions already stops it resolving).
 */
export function escapeMarkdown(raw: string): string {
  const trimmed = raw.length > NAME_MAX ? `${raw.slice(0, NAME_MAX - 1)}…` : raw;
  return (
    trimmed
      .replace(/[\\*_~`|<>[\]()@#-]/g, (c) => `\\${c}`)
      // Escaping brackets kills `[label](evil)`, but Discord ALSO auto-links a
      // BARE url, and none of the characters that make one (`:` `/` `.`) can be
      // escaped without mangling ordinary names. A zero-width space after the
      // scheme breaks the match while leaving the text visually identical — so
      // a persona of "evil.test/free-mmr" can't become a live link in a message
      // the league is told to pin forever.
      .replace(/(https?):\/\//gi, "$1:​//")
      .replace(/\bwww\./gi, "www​.")
  );
}

function nameList(names: string[]): string {
  const shown = names.slice(0, NAMES_SHOWN).map(escapeMarkdown);
  const extra = names.length - shown.length;
  return extra > 0 ? `${shown.join(", ")} +${extra} more` : shown.join(", ");
}

/** A 10-cell progress bar. Never renders more filled cells than there are. */
export function progressBar(filled: number, total: number): string {
  const cells = Math.max(1, Math.min(20, total));
  const on = Math.max(0, Math.min(cells, filled));
  return `${"█".repeat(on)}${"░".repeat(cells - on)}`;
}

/** `<t:epoch:R>` — Discord renders this live ("3 minutes ago") in every
 *  client, in their own locale, without us editing the message again. */
function relative(ms: number): string {
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

/**
 * Digest key for "who is in the queue", order-insensitive (join order changing
 * is not a state change worth an edit). JSON.stringify rather than a joined
 * string because player names are arbitrary text: `["ab","c"]` and `["a","bc"]`
 * are different queues and must not collide on any separator a name could
 * contain.
 */
function rosterKey(names: string[]): string {
  return JSON.stringify([...names].sort());
}

function lobbyPhase(status: string): "check" | "draft" | "live" | null {
  if (status === INHOUSE_STATUS.READY_CHECK) return "check";
  if (
    status === INHOUSE_STATUS.CAPTAIN_VOTE ||
    status === INHOUSE_STATUS.DRAFTING ||
    status === INHOUSE_STATUS.READY
  ) {
    return "draft";
  }
  if (status === INHOUSE_STATUS.IN_PROGRESS) return "live";
  return null;
}

export function renderBoard(s: BoardSnapshot): BoardRender {
  const url = `${s.siteUrl}/inhouse`;
  const present = s.presentNames.length;
  const cta = `[Queue up →](${url})`;
  const updated = `updated ${relative(s.nowMs)}`;

  // --- A lobby is up: the board stops being a counter and becomes a status. --
  const phase = s.lobby ? lobbyPhase(s.lobby.status) : null;
  if (s.lobby && phase) {
    const inLine =
      present > 0
        ? `\n**${present}** in line for the next game — ${nameList(s.presentNames)}`
        : "";
    let title: string;
    let body: string;
    let color: number;
    if (phase === "check") {
      const acc = s.lobby.acceptedCount;
      title = `🚨 Match found — ${acc}/${s.lobby.playerCount} accepted`;
      body = `\`${progressBar(acc, s.lobby.playerCount)}\`  Players are accepting now.`;
      color = COLOR.CLOSE;
    } else if (phase === "draft") {
      title = "🧢 Picking teams…";
      body = "Captains are drafting. Next game starts right after.";
      color = COLOR.LOBBY;
    } else {
      title = "🎮 Game in progress";
      body = s.lobby.startedAtMs
        ? `Started ${relative(s.lobby.startedAtMs)} — the result posts here when it lands.`
        : "The result posts here when it lands.";
      color = COLOR.LIVE;
    }
    return {
      // startedAtMs pins the digest to THIS game: back-to-back lobbies in the
      // same phase would otherwise render an identical board and never repaint.
      digest: [
        phase,
        s.lobby.status,
        s.lobby.acceptedCount,
        s.lobby.playerCount,
        s.lobby.startedAtMs ?? "",
        present,
        rosterKey(s.presentNames),
      ].join("|"),
      embed: {
        title,
        url,
        description: `${body}${inLine}\n\n${updated} · ${cta}`,
        color,
      },
    };
  }

  // --- No lobby: the counter. -----------------------------------------------
  const needed = Math.max(0, s.lobbySize - present);
  const away =
    s.awayCount > 0
      ? `\n_${s.awayCount} away_ — idle tabs, not counted toward the ${s.lobbySize}.`
      : "";

  if (present === 0) {
    return {
      digest: `idle|${s.awayCount}`,
      embed: {
        title: "🎮 Inhouse — the queue is empty",
        url,
        description: `Ten players and a lobby fires. Be the first in.${away}\n\n${updated} · ${cta}`,
        color: COLOR.IDLE,
      },
    };
  }

  const bar = `\`${progressBar(present, s.lobbySize)}\``;
  const call =
    needed === 0
      ? "**Lobby is forming!**"
      : `**${needed} more** ${needed === 1 ? "player" : "players"} and the lobby fires.`;
  return {
    digest: `queue|${present}|${s.awayCount}|${rosterKey(s.presentNames)}`,
    embed: {
      title: `🎮 Inhouse queue — ${present}/${s.lobbySize}`,
      url,
      description: `${bar}  ${call}\n**In queue:** ${nameList(s.presentNames)}${away}\n\n${updated} · ${cta}`,
      color: needed <= 2 ? COLOR.CLOSE : COLOR.FILLING,
    },
  };
}

/**
 * One-line "what the queue actually is right now", for the admin card. Paired
 * with a digest comparison it answers the only question worth asking about a
 * live board: is the channel currently showing the truth?
 */
export function boardStateLabel(s: BoardSnapshot): string {
  if (s.lobby) {
    const waiting =
      s.presentNames.length > 0 ? `, ${s.presentNames.length} waiting` : "";
    return `lobby ${s.lobby.status.toLowerCase().replace(/_/g, " ")}${waiting}`;
  }
  const away = s.awayCount > 0 ? ` (+${s.awayCount} away)` : "";
  return `${s.presentNames.length}/${s.lobbySize} queued${away}`;
}
