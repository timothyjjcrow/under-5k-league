// @ts-check
// The stream overlay's browser code: a caster adds /overlay/<match id> to OBS
// as a Browser source and this draws the matchup bar and the rotating player
// cards over the stream (docs/features/pages-and-ui.md, "Stream overlay").
//
// It is plain JavaScript on purpose. ../overlay/[id]/route.ts reads this file
// and inlines it into a page that sits outside the site's layout (no header,
// no footer, a transparent background), and Vercel's CDN serves that page.
// The pure helpers are exported for overlay-client.test.ts; in a browser the
// exports are simply unused.
//
// Updates cost the site almost nothing. Every 30 seconds the page reads
// /api/sync (a CDN-cached answer, no function call on a hit) and asks for
// /api/overlay/<id>/<version> only when the version moves: the result cursor
// (a game imported, a result corrected) or, until the series is decided, a
// 10-minute bucket that picks up a late standin or a retimed kickoff. Each
// version is a new URL the CDN answers for everyone after the first request.
// Nothing here ever writes, imports a game or calls OpenDota.
//
// Written for OBS's built-in Chromium, which can trail Chrome by years: no
// syntax or CSS newer than Chromium 103, and every image falls back cleanly.

/** @typedef {import("../../lib/stream-overlay").StreamOverlayPayload} Payload */
/** @typedef {import("../../lib/stream-overlay").OverlayTeam} Team */
/** @typedef {import("../../lib/stream-overlay").OverlayPlayer} Player */
/** @typedef {Payload["match"]} Match */

/** How often the page reads /api/sync (its CDN copy refreshes every 30s). */
export const SYNC_POLL_MS = 30_000;
/** Until a series is decided, a new version every this often catches what
 *  doesn't move the result cursor: a standin booked late, a retimed kickoff. */
export const REFRESH_BUCKET_MS = 10 * 60_000;
/** A request that never answers would otherwise hold the next poll back. */
const FETCH_TIMEOUT_MS = 8_000;
/** Seconds each player card stays up. */
export const CARD_SECONDS = { fallback: 9, min: 4, max: 60 };
/** The status line counts down over the last hour before kickoff. */
const COUNTDOWN_FROM_MS = 60 * 60_000;
/** Seconds each line of the matchup's ticker stays up. */
const NOTE_SECONDS = 7;
/** The payload shape this page draws (STREAM_OVERLAY_VERSION). */
const PAYLOAD_VERSION = 1;
/** Characters a team name fits on one line of the matchup bar. */
const LONG_TEAM_NAME = 16;

/**
 * @typedef {{
 *   widget: "both" | "matchup" | "players",
 *   side: "both" | "home" | "away",
 *   seconds: number,
 *   preview: boolean,
 *   notes: boolean,
 * }} OverlayOptions
 */

/**
 * The link's options. A repeated key counts as unset, as on the site's pages
 * (singleSearchParam), and anything unknown falls back to the default.
 * @param {string} search
 * @returns {OverlayOptions}
 */
export function overlayOptions(search) {
  const params = new URLSearchParams(search);
  /** @param {string} key */
  const one = (key) => {
    const all = params.getAll(key);
    return all.length === 1 ? all[0].trim().toLowerCase() : null;
  };
  const widget = one("widget");
  const side = one("side");
  const seconds = Number(one("seconds") ?? Number.NaN);
  return {
    widget: widget === "matchup" || widget === "players" ? widget : "both",
    side: side === "home" || side === "away" ? side : "both",
    seconds:
      Number.isFinite(seconds) && seconds > 0
        ? Math.min(CARD_SECONDS.max, Math.max(CARD_SECONDS.min, Math.round(seconds)))
        : CARD_SECONDS.fallback,
    preview: one("preview") === "1",
    notes: one("notes") !== "0",
  };
}

/**
 * The data route's version segment: the result cursor in base 36, then the
 * refresh bucket, or "f" once the series is decided (only a result change can
 * move a decided series). Everyone in one bucket asks for the same URL, so
 * the CDN answers all but the first.
 * @param {string | null} cursor `/api/sync`'s ISO cursor
 * @param {number} nowMs
 * @param {boolean} decided
 */
export function overlayRevision(cursor, nowMs, decided) {
  const parsed = cursor ? Date.parse(cursor) : Number.NaN;
  const cursorPart =
    Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed).toString(36) : "0";
  const bucketPart = decided
    ? "f"
    : Math.floor(nowMs / REFRESH_BUCKET_MS).toString(36);
  return `${cursorPart}.${bucketPart}`;
}

/**
 * "12:05", or "1:02:03" with hours.
 * @param {number} ms
 */
export function countdownText(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  /** @param {number} n */
  const pad = (n) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/** How long a series is expected to last (series-lengths.ts' estimate).
 * @param {number} bestOf */
function seriesMinutes(bestOf) {
  return bestOf * 60 + 30;
}

/**
 * The matchup's status line right now, from the payload and the clock.
 * @param {Match} match
 * @param {number} nowMs
 * @returns {{ text: string, live: boolean, started: boolean }}
 */
export function matchStatus(match, nowMs) {
  const played = match.homeScore + match.awayScore;
  if (match.status === "COMPLETED") {
    return { text: match.forfeit ? "Final · forfeit" : "Final", live: false, started: true };
  }
  const kickoff = match.kickoffMs;
  const started =
    match.status === "LIVE" || played > 0 || (kickoff !== null && nowMs >= kickoff);
  if (!started) {
    if (kickoff !== null && kickoff - nowMs <= COUNTDOWN_FROM_MS) {
      return { text: `Starts in ${countdownText(kickoff - nowMs)}`, live: false, started };
    }
    return { text: match.kickoffText ?? `Best of ${match.bestOf}`, live: false, started };
  }
  // Long past kickoff with nothing recorded: say so rather than "live".
  if (
    match.status !== "LIVE" &&
    played === 0 &&
    kickoff !== null &&
    nowMs > kickoff + 2 * seriesMinutes(match.bestOf) * 60_000
  ) {
    return { text: "Awaiting result", live: false, started };
  }
  const game = Math.min(Math.max(1, match.bestOf), played + 1);
  return { text: `Game ${game} · Bo${match.bestOf}`, live: true, started };
}

/**
 * The cards to rotate through: one side's players, or both sides'.
 * @param {Player[]} players
 * @param {OverlayOptions["side"]} side
 */
export function cardQueue(players, side) {
  return side === "both" ? players : players.filter((p) => p.side === side);
}

/**
 * Where to resume after new data: the same player if they are still in the
 * queue, else the same position.
 * @param {Player[]} queue
 * @param {string | null} currentId
 * @param {number} currentIndex
 */
export function resumeIndex(queue, currentId, currentIndex) {
  if (queue.length === 0) return 0;
  const same = currentId ? queue.findIndex((p) => p.id === currentId) : -1;
  if (same >= 0) return same;
  return Math.min(Math.max(0, currentIndex), queue.length - 1);
}

/**
 * "4–2" style record, "7.2 / 3.1 / 11.4" style averages.
 * @param {number} value
 */
export function oneDecimal(value) {
  return (Math.round(value * 10) / 10).toFixed(1);
}

/**
 * The player card's tag line: "Captain", "Standin for X", positions.
 * @param {Player} player
 */
export function playerTags(player) {
  /** @type {string[]} */
  const tags = [];
  if (player.captain) tags.push("Captain");
  if (player.standin) {
    tags.push(player.standinFor ? `Standin for ${player.standinFor}` : "Standin");
  }
  if (player.roles.length > 0) tags.push(player.roles.join(" · "));
  return tags;
}

/** True for an image URL the page may load: https, or the site's own files.
 * @param {string | null | undefined} url */
export function safeImageUrl(url) {
  if (!url) return false;
  if (url.startsWith("/ranks/") || url.startsWith("/brand/") || url === "/icon.svg") {
    return true;
  }
  return /^https:\/\//i.test(url);
}

// ---------- Drawing ----------
// Everything below touches the DOM. Text always goes in through textContent:
// team and player names are typed by players.

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string | null} [text]
 * @returns {HTMLElement}
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/**
 * An image that removes itself if it fails, so the fallback under it shows.
 * @param {string} src
 * @param {string} className
 * @param {() => void} [onLoad]
 */
function image(src, className, onLoad) {
  const img = /** @type {HTMLImageElement} */ (el("img", className));
  img.alt = "";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.addEventListener("error", () => img.remove());
  if (onLoad) img.addEventListener("load", onLoad);
  img.src = src;
  return img;
}

/** @param {HTMLElement} node @param {Team} team */
function paintTeam(node, team) {
  node.style.setProperty("--hue", String(team.hue));
  node.style.setProperty("--ink", team.ink);
}

/** @param {Team} team @param {string} className */
function crest(team, className) {
  const box = el("div", `ov-crest ${className}`);
  paintTeam(box, team);
  box.appendChild(el("span", "ov-crest-initials", team.initials));
  if (safeImageUrl(team.logoUrl)) {
    box.appendChild(
      image(/** @type {string} */ (team.logoUrl), "ov-crest-logo", () =>
        box.classList.add("ov-crest-has-logo"),
      ),
    );
  }
  return box;
}

/** @param {import("../../lib/team-matches").FormResult[]} form */
function formStrip(form) {
  const strip = el("div", "ov-form");
  for (const result of form) {
    const chip = el("span", `ov-form-chip ov-form-${result.toLowerCase()}`, result);
    strip.appendChild(chip);
  }
  return strip;
}

/**
 * @param {Team} team
 * @param {"home" | "away"} side
 * @param {Match} match
 */
function teamBlock(team, side, match) {
  const block = el("div", `ov-team ov-team-${side}`);
  paintTeam(block, team);
  if (match.winner === side) block.classList.add("ov-team-won");
  if (match.winner && match.winner !== side) block.classList.add("ov-team-lost");
  block.appendChild(crest(team, "ov-team-crest"));
  const text = el("div", "ov-team-text");
  const name = el("div", "ov-team-name", team.name);
  // A long name drops a size (two for a very long one) and may take two
  // lines rather than lose its words.
  const length = Array.from(team.name).length;
  if (length > LONG_TEAM_NAME) name.classList.add("ov-long");
  if (length > 2 * LONG_TEAM_NAME) name.classList.add("ov-longer");
  text.appendChild(name);
  const meta = [team.record, team.standing].filter(Boolean).join(" · ");
  if (meta) text.appendChild(el("div", "ov-team-meta", meta));
  if (team.form.length > 0) text.appendChild(formStrip(team.form));
  block.appendChild(text);
  return block;
}

/**
 * The matchup bar: both teams, the round and the series score, with its
 * status line (which the page repaints every second).
 * @param {Payload} data
 * @param {{ emblem: string | null, blend: string }} brand
 * @returns {{ bar: HTMLElement, status: HTMLElement }}
 */
function matchupBar(data, brand) {
  const { match } = data;
  const bar = el("section", "ov-matchup");
  bar.setAttribute("aria-label", `${data.home.name} versus ${data.away.name}`);
  bar.appendChild(teamBlock(data.home, "home", match));

  const center = el("div", "ov-center");
  const top = el("div", "ov-round");
  if (brand.emblem && safeImageUrl(brand.emblem)) {
    const emblem = image(brand.emblem, "ov-emblem");
    if (brand.blend === "lighten") emblem.classList.add("ov-emblem-lighten");
    top.appendChild(emblem);
  }
  top.appendChild(el("span", "ov-round-text", `${match.round} · Bo${match.bestOf}`));
  center.appendChild(top);

  const score = el("div", "ov-score");
  score.dataset.home = String(match.homeScore);
  score.dataset.away = String(match.awayScore);
  const homeScore = el("span", "ov-score-num ov-score-home", String(match.homeScore));
  const awayScore = el("span", "ov-score-num ov-score-away", String(match.awayScore));
  if (match.winner === "home") homeScore.classList.add("ov-score-won");
  if (match.winner === "away") awayScore.classList.add("ov-score-won");
  score.appendChild(homeScore);
  score.appendChild(el("span", "ov-score-sep", "–"));
  score.appendChild(awayScore);
  center.appendChild(score);

  const status = el("div", "ov-status");
  status.setAttribute("role", "timer");
  center.appendChild(status);
  bar.appendChild(center);

  bar.appendChild(teamBlock(data.away, "away", match));
  return { bar, status };
}

/** @param {HTMLElement} status @param {Match} match @param {number} nowMs */
function paintStatus(status, match, nowMs) {
  const now = matchStatus(match, nowMs);
  if (status.dataset.text !== now.text || status.dataset.live !== String(now.live)) {
    status.dataset.text = now.text;
    status.dataset.live = String(now.live);
    status.textContent = "";
    if (now.live) status.appendChild(el("span", "ov-live", "Live"));
    status.appendChild(el("span", "ov-status-text", now.text));
  }
  const score = status.parentElement?.querySelector(".ov-score");
  // Before the first game the score slot says "vs": 0–0 reads like a result.
  if (score instanceof HTMLElement) score.classList.toggle("ov-score-vs", !now.started);
}

/**
 * One player card.
 * @param {Player} player
 * @param {Team} team
 * @param {{ index: number, total: number, seconds: number }} place
 */
function playerCard(player, team, place) {
  const card = el("article", "ov-card");
  card.setAttribute("aria-label", player.name);
  paintTeam(card, team);

  const head = el("header", "ov-card-head");
  head.appendChild(crest(team, "ov-card-crest"));
  head.appendChild(el("span", "ov-card-team", team.name));
  head.appendChild(el("span", "ov-card-count", `${place.index + 1} / ${place.total}`));
  card.appendChild(head);

  const body = el("div", "ov-card-body");
  const avatar = el("div", "ov-avatar");
  avatar.appendChild(el("span", "ov-avatar-initials", initialsOf(player.name)));
  if (safeImageUrl(player.avatar)) {
    avatar.appendChild(image(/** @type {string} */ (player.avatar), "ov-avatar-img"));
  }
  body.appendChild(avatar);

  const id = el("div", "ov-id");
  id.appendChild(el("div", "ov-name", player.name));
  const tags = el("div", "ov-tags");
  for (const tag of playerTags(player)) {
    const strong = tag === "Captain" || tag.startsWith("Standin");
    tags.appendChild(el("span", strong ? "ov-tag ov-tag-strong" : "ov-tag", tag));
  }
  id.appendChild(tags);
  body.appendChild(id);

  if (player.medal && safeImageUrl(player.medal.icon)) {
    const medal = el("div", "ov-medal");
    const art = el("div", "ov-medal-art");
    art.appendChild(image(player.medal.icon, "ov-medal-icon"));
    if (player.medal.star && safeImageUrl(player.medal.star)) {
      art.appendChild(image(player.medal.star, "ov-medal-star"));
    }
    medal.appendChild(art);
    medal.appendChild(el("div", "ov-medal-name", player.medal.name));
    body.appendChild(medal);
  }
  card.appendChild(body);

  const season = player.season;
  if (season) {
    const stats = el("div", "ov-stats");
    /** @param {string} label @param {string} value */
    const stat = (label, value) => {
      const cell = el("div", "ov-stat");
      cell.appendChild(el("div", "ov-stat-value", value));
      cell.appendChild(el("div", "ov-stat-label", label));
      stats.appendChild(cell);
    };
    stat("Games", String(season.games));
    stat("Record", `${season.wins}–${season.losses}`);
    stat(
      "K / D / A",
      `${oneDecimal(season.kills)} / ${oneDecimal(season.deaths)} / ${oneDecimal(season.assists)}`,
    );
    stat("Impact / game", String(season.impact));
    // Match MVPs once they have one; until then the KDA ratio, rather than
    // a zero on stream.
    if (season.mvps > 0) {
      stat(season.mvps === 1 ? "Match MVP" : "Match MVPs", String(season.mvps));
    } else {
      stat("KDA", oneDecimal(season.kda));
    }
    card.appendChild(stats);
  } else {
    card.appendChild(el("div", "ov-stats ov-stats-empty", "First league game of the season"));
  }

  if (player.heroes.length > 0) {
    const heroes = el("div", "ov-heroes");
    heroes.appendChild(
      el(
        "div",
        "ov-heroes-label",
        player.heroesFrom === "pubs" ? "Top heroes in pubs" : "Most played this season",
      ),
    );
    const row = el("div", "ov-hero-row");
    for (const hero of player.heroes) {
      const tile = el("div", "ov-hero");
      const art = el("div", "ov-hero-art");
      art.appendChild(el("span", "ov-hero-fallback", hero.name));
      if (safeImageUrl(hero.portrait)) {
        art.appendChild(
          image(hero.portrait, "ov-hero-img", () => art.classList.add("ov-hero-has-art")),
        );
      }
      tile.appendChild(art);
      const caption = el("div", "ov-hero-caption");
      caption.appendChild(el("span", "ov-hero-name", hero.name));
      caption.appendChild(
        el(
          "span",
          "ov-hero-games",
          player.heroesFrom === "pubs"
            ? `${hero.games} games`
            : `${hero.wins}–${hero.games - hero.wins}`,
        ),
      );
      tile.appendChild(caption);
      row.appendChild(tile);
    }
    heroes.appendChild(row);
    card.appendChild(heroes);
  }

  const progress = el("div", "ov-progress");
  const fill = el("span", "ov-progress-fill");
  fill.style.animationDuration = `${place.seconds}s`;
  progress.appendChild(fill);
  card.appendChild(progress);
  return card;
}

/** Two letters for a player without an avatar. @param {string} name */
function initialsOf(name) {
  const words = name.split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[1]] : [name];
  return letters
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

/**
 * Starts the overlay in a browser. Returns nothing; everything it needs is
 * on the page: the match id in the path and the league's emblem in
 * #overlay-config.
 */
function start() {
  const root = document.getElementById("overlay");
  const configNode = document.getElementById("overlay-config");
  if (!root || !configNode) return;
  /** @type {{ matchId: string, emblem: string | null, blend: string }} */
  const config = JSON.parse(configNode.textContent || "{}");
  const options = overlayOptions(window.location.search);
  const inObs = "obsstudio" in window;
  // On the root: the widget picks the root font size every rem scales from.
  const page = document.documentElement;
  page.classList.add(`ov-widget-${options.widget}`);
  if (options.preview && !inObs) page.classList.add("ov-preview");

  /** @type {Payload | null} */
  let data = null;
  /** @type {string | null} */
  let cursor = null;
  /** @type {string | null} */
  let shownRevision = null;
  let decided = false;
  let sourceVisible = true;
  let polling = false;

  const matchupSlot = el("div", "ov-slot ov-slot-matchup");
  const tickerSlot = el("div", "ov-slot ov-slot-ticker");
  const cardsSlot = el("div", "ov-slot ov-slot-cards");
  root.appendChild(matchupSlot);
  root.appendChild(tickerSlot);
  root.appendChild(cardsSlot);
  const notice = el("p", "ov-notice");
  root.appendChild(notice);

  /** @type {HTMLElement | null} */
  let status = null;
  let shownMatchup = "";

  /** @param {string} text */
  const say = (text) => {
    notice.textContent = options.preview ? text : "";
  };

  // ---- Matchup bar and its ticker ----
  /** @type {string[]} */
  let notes = [];
  let noteIndex = 0;
  const drawMatchup = () => {
    if (!data || options.widget === "players") return;
    const key = JSON.stringify([data.match, data.home, data.away]);
    if (key === shownMatchup) return;
    const previous = matchupSlot.querySelector(".ov-score");
    const before = previous instanceof HTMLElement
      ? { home: previous.dataset.home, away: previous.dataset.away }
      : null;
    shownMatchup = key;
    const drawn = matchupBar(data, config);
    matchupSlot.textContent = "";
    matchupSlot.appendChild(drawn.bar);
    status = drawn.status;
    paintStatus(drawn.status, data.match, Date.now());
    // A score that just moved gets a pulse, so the change is seen on stream.
    if (before) {
      const home = matchupSlot.querySelector(".ov-score-home");
      const away = matchupSlot.querySelector(".ov-score-away");
      if (home && before.home !== String(data.match.homeScore)) home.classList.add("ov-pulse");
      if (away && before.away !== String(data.match.awayScore)) away.classList.add("ov-pulse");
    }
  };
  const drawNote = () => {
    if (!options.notes || options.widget === "players" || notes.length === 0) {
      tickerSlot.textContent = "";
      return;
    }
    const text = notes[noteIndex % notes.length];
    const ticker = el("div", "ov-ticker");
    if (data) paintTeam(ticker, data.home);
    ticker.appendChild(el("span", "ov-ticker-text", text));
    tickerSlot.textContent = "";
    tickerSlot.appendChild(ticker);
  };

  // ---- Player cards ----
  /** @type {Player[]} */
  let queue = [];
  let cardIndex = 0;
  /** @type {string | null} */
  let cardId = null;
  /** @type {number | undefined} */
  let cardTimer;
  const showCard = () => {
    window.clearTimeout(cardTimer);
    if (!data || options.widget === "matchup" || queue.length === 0) {
      cardsSlot.textContent = "";
      return;
    }
    cardIndex = cardIndex % queue.length;
    const player = queue[cardIndex];
    const team = player.side === "home" ? data.home : data.away;
    const sideTotal = queue.filter((p) => p.side === player.side);
    const card = playerCard(player, team, {
      index: sideTotal.findIndex((p) => p.id === player.id),
      total: sideTotal.length,
      seconds: options.seconds,
    });
    cardId = player.id;
    for (const old of Array.from(cardsSlot.children)) {
      old.classList.add("ov-leave");
      window.setTimeout(() => old.remove(), 700);
    }
    card.classList.add("ov-enter");
    cardsSlot.appendChild(card);
    // Reading its width makes the browser lay out the entering state, so
    // dropping the class animates from it. (Animation frames would wait on
    // a page the browser considers hidden.)
    void card.offsetWidth;
    card.classList.remove("ov-enter");
    // Warm the next card's pictures so it never pops in half-drawn.
    const next = queue[(cardIndex + 1) % queue.length];
    for (const src of [next.avatar, ...next.heroes.map((h) => h.portrait)]) {
      if (safeImageUrl(src)) new Image().src = /** @type {string} */ (src);
    }
    cardTimer = window.setTimeout(() => {
      cardIndex = (cardIndex + 1) % queue.length;
      showCard();
    }, options.seconds * 1000);
  };

  /** @param {Payload} next */
  const apply = (next) => {
    data = next;
    decided = next.match.status === "COMPLETED";
    notes = next.notes;
    drawMatchup();
    drawNote();
    const nextQueue = cardQueue(next.players, options.side);
    const restart = queue.length === 0;
    cardIndex = resumeIndex(nextQueue, cardId, cardIndex);
    queue = nextQueue;
    if (restart || !cardsSlot.firstElementChild) showCard();
    say(
      options.widget !== "matchup" && queue.length === 0
        ? "No players on these rosters yet."
        : "",
    );
  };

  /**
   * GET some JSON with a timeout: the parsed body, "missing" for a 404, or
   * null when it couldn't be read (the page keeps what it shows and tries
   * again on the next poll).
   * @param {string} url
   * @returns {Promise<unknown>}
   */
  const getJson = async (url) => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, credentials: "omit" });
      if (res.status === 404) return "missing";
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      window.clearTimeout(timer);
    }
  };

  const poll = async () => {
    if (polling) return;
    // After the first draw, a hidden source or tab asks for nothing. (The
    // first always runs: some streaming tools report their browser hidden.)
    if (data && (!sourceVisible || (!inObs && document.visibilityState === "hidden"))) {
      return;
    }
    polling = true;
    try {
      const sync = await getJson("/api/sync");
      if (sync && typeof sync === "object" && "cursor" in sync) {
        const value = /** @type {{ cursor: unknown }} */ (sync).cursor;
        cursor = typeof value === "string" ? value : null;
      }
      const revision = overlayRevision(cursor, Date.now(), decided);
      if (revision === shownRevision) return;
      const next = await getJson(
        `/api/overlay/${encodeURIComponent(config.matchId)}/${revision}`,
      );
      if (next === "missing") {
        shownRevision = revision;
        say("No match with this link. Copy it again from the match page.");
        return;
      }
      if (!next || typeof next !== "object") return;
      const payload = /** @type {Payload} */ (next);
      if (payload.version !== PAYLOAD_VERSION) {
        // The site was updated under a page that stayed open: load the new
        // page, at most once every ten minutes.
        if (!reloadOnce()) say("This overlay is out of date. Refresh the source in OBS.");
        return;
      }
      apply(payload);
      // A decided series' next version is "f": take this answer as it.
      shownRevision = overlayRevision(cursor, Date.now(), decided);
    } finally {
      polling = false;
    }
  };

  // OBS tells a Browser source when it is shown or hidden; a hidden overlay
  // asks for nothing.
  window.addEventListener("obsSourceVisibleChanged", (event) => {
    const detail = /** @type {CustomEvent<{ visible?: boolean }>} */ (event).detail;
    sourceVisible = detail?.visible !== false;
    if (sourceVisible) void poll();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void poll();
  });

  window.setInterval(() => void poll(), SYNC_POLL_MS);
  window.setInterval(() => {
    if (data && status) paintStatus(status, data.match, Date.now());
  }, 1000);
  window.setInterval(() => {
    if (notes.length > 1) {
      noteIndex = (noteIndex + 1) % notes.length;
      drawNote();
    }
  }, NOTE_SECONDS * 1000);
  void poll();
}

/**
 * Reload the page for a newer payload, unless it already did in the last ten
 * minutes. Without storage it never reloads: it can't tell a loop from one.
 * @returns {boolean} whether it reloaded
 */
function reloadOnce() {
  const key = "ggd2l-overlay-reloaded";
  try {
    const last = Number(window.sessionStorage.getItem(key) ?? 0);
    if (Date.now() - last < REFRESH_BUCKET_MS) return false;
    window.sessionStorage.setItem(key, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
}
