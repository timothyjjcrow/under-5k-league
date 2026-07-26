import { INHOUSE_STATUS } from "./constants";

// The live inhouse queue board: ONE Discord message the site rewrites in place
// instead of posting a new "6/10 queued" line every time somebody joins.
//
// Everything here is pure — no DB, no fetch — so every state below is a table
// test. The service (inhouse-board-service.ts) owns the message id, the
// throttle claim and the PATCH; this file only answers "what should the board
// say right now, and has that changed?".
//
// DESIGN — "Find Match". The board borrows Dota's own matchmaking script
// (Find Match → Searching → Match Found → Preparing → live), because every
// state name is then a phrase the reader has already seen a thousand times.
// Two glyphs carry the whole visual language: ▰ taken, ▱ open. Horizontal
// where there are no names (a rack), vertical where there are (Dota's lobby
// slot list). The trailing `▱ open` rows ARE the call to action — at 9/10 a
// column of nine names above one open slot is the most persuasive thing this
// channel can render, and it needs no copy to explain it.
//
// NO EMOJI, deliberately. This message is pinned, edited in place and lives
// alone in its channel — it is permanently on screen. Anything decorative on a
// permanently-visible surface becomes wallpaper within a day and drags the
// information beside it down with it. Colour does that job instead: the 4px
// bar is a peripheral-vision signal that changes without the reader parsing
// anything, and unlike an emoji it cannot go stale through familiarity because
// it carries real information rather than sitting next to it.
//
// The DIGEST is the cost model. It hashes the SEMANTIC state only and
// deliberately EXCLUDES the clock — that exclusion is what stops a motionless
// queue from burning one edit per throttle window forever. Anything
// time-varying in the digest turns this feature into a permanent
// 6-edits-per-minute drip on an empty queue: keep wall-clock time out of it,
// and render elapsed time with Discord's own <t:…:R> markup, which keeps
// counting in every client with no further edits from us.

export type BoardLobby = {
  status: string;
  /** READY_CHECK only: how many of the ten have pressed accept. */
  acceptedCount: number;
  playerCount: number;
  /** Epoch ms the game was marked started (IN_PROGRESS), else null. */
  startedAtMs: number | null;
  /** Epoch ms the ready check expires. Stable for the life of ONE check, so
   *  it is digest-safe: it costs no extra edits and correctly forces a
   *  repaint when a NEW check opens. */
  acceptEndsAtMs: number | null;
  /** Ready check: who has and hasn't accepted. Same rows the service already
   *  loads — no extra query. Dota shows this grid for a reason. */
  acceptedNames: string[];
  pendingNames: string[];
};

/**
 * Proof-of-life for the EMPTY state — the one shown ~95% of the time, where a
 * 0/10 counter alone reads as a dead league. Every figure here is monotonic or
 * completes-with-a-state-change (all-time counts, the last finished result,
 * the ladder leader) and NEVER a trailing window: the board repaints only when
 * its digest changes, so "14 games this week" would silently rot through the
 * exact quiet stretch it was meant to paper over.
 *
 * Any field that doesn't exist is OMITTED, never faked. A brand-new league
 * with no games shows no stat row at all — not "0 games played".
 */
export type BoardStats = {
  /** Identity of the last finished game — digest key, so a new result repaints. */
  lastLobbyId: string | null;
  lastEndedAtMs: number | null;
  /** "Radiant"/"Dire", or null when the sides aren't known (never guess). */
  lastWinnerSide: string | null;
  lastRadiantScore: number | null;
  lastDireScore: number | null;
  mvpName: string | null;
  mvpHero: string | null;
  /** All-time completed lobbies. Monotonic, so digest-safe. */
  lobbiesPlayed: number;
  /** Top of the Elo ladder — established players only, never a provisional. */
  ladderName: string | null;
  ladderRating: number | null;
};

export type BoardSnapshot = {
  /** Present queue entries in join order. While a lobby is up these are the
   *  players waiting for the NEXT game, not the ten who are playing. */
  presentNames: string[];
  /** Entries whose heartbeat went quiet — listed on site, never counted. */
  awayCount: number;
  lobbySize: number;
  lobby: BoardLobby | null;
  /** Only loaded for the empty render; null everywhere else. */
  stats: BoardStats | null;
  siteUrl: string;
  nowMs: number;
};

export type BoardField = { name: string; value: string; inline: boolean };

export type BoardEmbed = {
  title: string;
  url: string;
  description: string;
  color: number;
  author: { name: string; icon_url: string; url: string };
  fields?: BoardField[];
  footer: { text: string };
};

export type BoardRender = { digest: string; embed: BoardEmbed };

/**
 * A temperature ramp, not a rainbow — each step means something and the
 * sequence reads as escalation. Notably EMPTY is steel blue rather than grey:
 * grey is the colour of a disabled button, and this is the state that has to
 * sell the league. READY_CHECK deliberately breaks the gold ramp with the
 * client's own accept green — it is the one state demanding a click inside 45
 * seconds. LIVE red means "broadcast", never Dire: which side is Radiant isn't
 * known until the match imports, so nothing here is ever side-labelled.
 */
const COLOR = {
  EMPTY: 0x4e6e8e,
  FILLING: 0xc8a653,
  NEARLY: 0xe39a2c,
  READY_CHECK: 0x8cc63f,
  PICKING: 0x2e6f7e,
  LIVE: 0xc0392b,
} as const;

const TAKEN = "▰";
const OPEN = "▱";

/** Longest a single player name may occupy on the board. */
const NAME_MAX = 32;
/** Names listed in a next-game list before collapsing the tail. */
const NAMES_SHOWN = 12;

const AUTHOR_ICON = "/brand/ggd2l-logo.png";

/**
 * Neutralise Discord markdown in player-supplied text (Steam personas, which
 * the player controls). Higher stakes here than in a transient announcement:
 * this message is pinned and never scrolls away, so a persona of `**` or a
 * `[label](evil.link)` would deface the channel permanently.
 *
 * NEWLINES ARE STRIPPED FIRST, before truncation, and that ordering is
 * load-bearing: the slot rack renders one player per LINE, so a persona
 * containing a newline would forge phantom rows and make the rack lie about
 * its own count. Escaping `<`/`>` likewise stops a persona forging a fake
 * <t:…> timestamp or a <@id> that LOOKS like a mention (allowed_mentions
 * already stops it resolving).
 */
export function escapeMarkdown(raw: string): string {
  const flat = raw.replace(/[\r\n\t]+/g, " ").trim();
  const trimmed =
    flat.length > NAME_MAX ? `${flat.slice(0, NAME_MAX - 1)}…` : flat;
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

/** Horizontal rack — used where there are no names to show. */
export function rack(taken: number, total: number): string {
  const cells = Math.max(0, Math.min(20, total));
  const on = Math.max(0, Math.min(cells, taken));
  return [...Array(cells)].map((_, i) => (i < on ? TAKEN : OPEN)).join(" ");
}

/** Two sides of five — same glyphs, new meaning. Deliberately UNLABELLED:
 *  Radiant/Dire isn't known until the match imports, and the board never
 *  guesses. */
function splitRack(total: number): string {
  const half = Math.max(1, Math.floor(total / 2));
  const side = [...Array(half)].map(() => TAKEN).join(" ");
  return `${side} │ ${side}`;
}

/**
 * Vertical rack — Dota's lobby slot list. One slot per LINE, so a 32-char
 * persona can never deform the layout (nothing shares a row) and the field is
 * the same height whether one player or nine is queued. The trailing open rows
 * are the invitation.
 */
function slotList(names: string[], total: number): string {
  const rows = names
    .slice(0, total)
    .map((n) => `${TAKEN} ${escapeMarkdown(n)}`);
  const spare = Math.max(0, total - rows.length);
  return [...rows, ...[...Array(spare)].map(() => `${OPEN} *open*`)].join("\n");
}

/** A plain list, for the next-game queue during a lobby (no fixed height). */
function plainList(names: string[]): string {
  const shown = names.slice(0, NAMES_SHOWN);
  const extra = names.length - shown.length;
  const rows = shown.map((n) => `${TAKEN} ${escapeMarkdown(n)}`);
  if (extra > 0) rows.push(`-# +${extra} more`);
  return rows.join("\n");
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

function lobbyPhase(status: string): "check" | "picking" | "live" | null {
  if (status === INHOUSE_STATUS.READY_CHECK) return "check";
  if (
    status === INHOUSE_STATUS.CAPTAIN_VOTE ||
    status === INHOUSE_STATUS.DRAFTING ||
    status === INHOUSE_STATUS.READY
  ) {
    return "picking";
  }
  if (status === INHOUSE_STATUS.IN_PROGRESS) return "live";
  return null;
}

const RAIL = "5v5 · captains draft · rated on the GGD2L ladder";

export function renderBoard(s: BoardSnapshot): BoardRender {
  const url = `${s.siteUrl}/inhouse`;
  const author = {
    name: "GGD2L Inhouse Matchmaking",
    icon_url: `${s.siteUrl}${AUTHOR_ICON}`,
    url,
  };
  const present = s.presentNames.length;
  const phase = s.lobby ? lobbyPhase(s.lobby.status) : null;

  // --- A lobby is up ---------------------------------------------------------
  if (s.lobby && phase) {
    const lobby = s.lobby;
    // presentNames during a lobby is the queue for the NEXT game — the ten who
    // are playing aren't in the queue table at all. So these states are built
    // around the split rack and the waiting list, which is the more useful
    // information anyway: not who's playing, but how close the next one is.
    const nextUp: BoardField[] =
      present > 0
        ? [
            {
              name: `IN LINE FOR THE NEXT GAME — ${present}`,
              value: `${plainList(s.presentNames)}\n-# ${Math.max(0, s.lobbySize - present)} more and the next lobby forms.`,
              inline: false,
            },
          ]
        : [];

    if (phase === "check") {
      const acc = lobby.acceptedCount;
      const expires = lobby.acceptEndsAtMs
        ? ` Expires ${relative(lobby.acceptEndsAtMs)}.`
        : "";
      const fields: BoardField[] =
        lobby.acceptedNames.length + lobby.pendingNames.length > 0
          ? [
              {
                name: `ACCEPTED — ${lobby.acceptedNames.length}`,
                value:
                  lobby.acceptedNames
                    .map((n) => `${TAKEN} ${escapeMarkdown(n)}`)
                    .join("\n") || "-# nobody yet",
                inline: true,
              },
              {
                name: `WAITING ON — ${lobby.pendingNames.length}`,
                value:
                  lobby.pendingNames
                    .map((n) => `${OPEN} ${escapeMarkdown(n)}`)
                    .join("\n") || "-# everyone in",
                inline: true,
              },
            ]
          : [];
      return {
        digest: [
          "check",
          acc,
          lobby.playerCount,
          lobby.acceptEndsAtMs ?? "",
          rosterKey(lobby.acceptedNames),
          present,
          rosterKey(s.presentNames),
        ].join("|"),
        embed: {
          title: `Match Found — ${acc} / ${lobby.playerCount} accepted`,
          url,
          author,
          color: COLOR.READY_CHECK,
          description: [
            "## Match found.",
            rack(acc, lobby.playerCount),
            "",
            `${acc} of ${lobby.playerCount} have accepted.${expires}`,
            "",
            `**[Accept your match →](${url})**`,
            "-# Anyone who doesn't accept is dropped and their slot reopens.",
          ].join("\n"),
          fields,
          footer: {
            text: "45 seconds to accept. No-shows are dropped from the queue.",
          },
        },
      };
    }

    if (phase === "picking") {
      // The header is the ONLY thing that changes across the three
      // sub-statuses, so all three look deliberate rather than lumped.
      const copy =
        lobby.status === INHOUSE_STATUS.CAPTAIN_VOTE
          ? {
              head: "## Voting on captains.",
              body: "Ten locked in. The lobby is choosing how captains get picked.",
            }
          : lobby.status === INHOUSE_STATUS.DRAFTING
            ? {
                head: "## Captains are drafting.",
                body: "Ten locked in, two sides forming. This one's closed.",
              }
            : {
                head: "## Teams are set.",
                body: "The Dota lobby is going up now.",
              };
      return {
        digest: [
          "picking",
          lobby.status,
          present,
          rosterKey(s.presentNames),
        ].join("|"),
        embed: {
          title: "Preparing Your Match",
          url,
          author,
          color: COLOR.PICKING,
          description: [
            copy.head,
            splitRack(lobby.playerCount),
            "",
            copy.body,
            "",
            `**[Queue for the next one →](${url})**`,
            `-# ${RAIL}`,
          ].join("\n"),
          fields: nextUp,
          footer: {
            text: "This lobby is full — anyone joining now is first into the next game.",
          },
        },
      };
    }

    // live
    const started = lobby.startedAtMs
      ? `Started ${relative(lobby.startedAtMs)}. `
      : "";
    return {
      digest: [
        "live",
        lobby.startedAtMs ?? "",
        present,
        rosterKey(s.presentNames),
      ].join("|"),
      embed: {
        title: "Match in Progress",
        url,
        author,
        color: COLOR.LIVE,
        description: [
          "## Live now.",
          splitRack(lobby.playerCount),
          "",
          `${started}The result imports itself and the ladder moves.`,
          "",
          `**[Queue for the next one →](${url})**`,
          `-# ${RAIL}`,
        ].join("\n"),
        fields: nextUp,
        footer: {
          text: "Results import from match history — nobody has to report anything.",
        },
      },
    };
  }

  // --- No lobby: the queue ---------------------------------------------------
  const needed = Math.max(0, s.lobbySize - present);
  const away = s.awayCount > 0 ? ` · ${s.awayCount} away` : "";

  if (present === 0) {
    // THE 95% STATE. A zero alone reads as a dead league, so the stat row —
    // recency, a name, a volume — is what proves the place is alive. All of it
    // degrades by removal: no data, no field, never a placeholder.
    const st = s.stats;
    const fields: BoardField[] = [];
    if (st?.lastEndedAtMs) {
      const score =
        st.lastRadiantScore != null && st.lastDireScore != null
          ? st.lastWinnerSide
            ? `**${st.lastWinnerSide}** ${st.lastRadiantScore} – ${st.lastDireScore}\n`
            : `**${st.lastRadiantScore} – ${st.lastDireScore}**\n`
          : "";
      fields.push({
        name: "LAST LOBBY",
        value: `${score}${relative(st.lastEndedAtMs)}`,
        inline: true,
      });
    }
    if (st?.mvpName) {
      fields.push({
        name: "MVP",
        value: `**${escapeMarkdown(st.mvpName)}**${st.mvpHero ? `\n-# ${st.mvpHero}` : ""}`,
        inline: true,
      });
    }
    if (st?.ladderName) {
      fields.push({
        name: "LADDER #1",
        value: `**${escapeMarkdown(st.ladderName)}**${st.ladderRating != null ? `\n-# ${st.ladderRating} rating` : ""}`,
        inline: true,
      });
    }
    const played = st && st.lobbiesPlayed > 0 ? ` · ${st.lobbiesPlayed} lobbies played` : "";
    const body =
      st && st.lobbiesPlayed > 0
        ? "Nobody wants to be the first name on an empty board — but this is the only message in the channel, and it repaints the second you join."
        : "No inhouse has been played here yet. Somebody has to host the first one.";
    return {
      // No "updated <t:R>" on this state ON PURPOSE: its digest barely moves,
      // so after a quiet weekend it would read "updated 3 days ago" — the
      // single most off-putting thing a conversion surface can say. The LAST
      // LOBBY field proves liveness honestly instead, and counts up for free.
      digest: [
        "idle",
        s.awayCount,
        st?.lastLobbyId ?? "",
        st?.lobbiesPlayed ?? 0,
        st?.ladderName ?? "",
      ].join("|"),
      embed: {
        title: `Find Match — ${s.lobbySize} slots open`,
        url,
        author,
        color: COLOR.EMPTY,
        description: [
          `## ${s.lobbySize === 10 ? "Ten" : s.lobbySize} slots open.`,
          rack(0, s.lobbySize),
          "",
          body,
          "",
          `**[Take the first slot →](${url})**`,
          `-# ${RAIL}${played}${away}`,
        ].join("\n"),
        fields,
        footer: {
          text: "Private lobby — no ticket, nothing to report. Results import from your match history.",
        },
      },
    };
  }

  // The header is always a short declarative — the count, spelled.
  const WORDS = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
  ];
  const nearly = needed <= 2;
  const head =
    needed === 0
      ? "## Lobby forming."
      : needed === 1
        ? "## One slot left."
        : nearly
          ? `## ${WORDS[needed]} slots left.`
          : `## ${WORDS[needed] ?? needed} more.`;
  const body =
    needed === 0
      ? "Ten in — the ready check is about to fire."
      : needed === 1
        ? // Prose spells the number, data uses numerals — that split is what
          // makes the board read as set rather than assembled.
          `${WORDS[present] ?? present} people are sat waiting on one click.`
        : "Ten and the ready check fires for everyone at once.";

  return {
    digest: [
      "queue",
      present,
      s.awayCount,
      rosterKey(s.presentNames),
    ].join("|"),
    embed: {
      title: `Searching for Match — ${present} / ${s.lobbySize}`,
      url,
      author,
      color: nearly ? COLOR.NEARLY : COLOR.FILLING,
      description: [
        head,
        rack(present, s.lobbySize),
        "",
        body,
        "",
        `**[Take ${needed === 1 ? "the last slot" : "a slot"} →](${url})**`,
        `-# ${RAIL} · queue last moved ${relative(s.nowMs)}`,
      ].join("\n"),
      fields: [
        {
          name: `IN QUEUE — ${present} / ${s.lobbySize}`,
          value:
            slotList(s.presentNames, s.lobbySize) +
            (s.awayCount > 0
              ? `\n-# ${s.awayCount} away — a tab that goes quiet for 90 seconds stops holding its slot.`
              : ""),
          inline: false,
        },
      ],
      footer: { text: "Your slot is held while the queue page is open in a tab." },
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
