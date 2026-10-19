// Structural checks for the Caddy and Cloudflare Tunnel configuration
// (design §1.7, §1.8). `caddy validate` and `cloudflared tunnel ingress
// validate` run on the box (install-kit.sh runs both); these pin what the
// design requires and keep the four hostnames, the leagues and the mode files
// from drifting apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SELFHOST = path.resolve(DIR, "..");
const read = (relative) => readFileSync(path.join(SELFHOST, relative), "utf8");
const HOSTS = ["us.ggd2l.com", "eu.ggd2l.com", "ggd2l.com", "www.ggd2l.com"];

/** Lines without comments or blank lines, each trimmed, with brace depth checked. */
function directives(text, name) {
  const lines = [];
  let depth = 0;
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    assert.doesNotMatch(raw, /^ +/, `${name}:${index + 1}: indent with tabs, as caddy fmt does`);
    assert.doesNotMatch(line, / #/, `${name}:${index + 1}: no trailing comments`);
    depth += (line.match(/\{(?![a-z_.]+\})/g) ?? []).length; // a placeholder like {uri} is not a block
    depth -= (line.match(/(?<!\{[a-z_.]+)\}/g) ?? []).length;
    assert.ok(depth >= 0, `${name}:${index + 1}: unbalanced }`);
    lines.push(line);
  });
  assert.equal(depth, 0, `${name}: unbalanced braces`);
  return lines;
}

/** The top-level blocks of a Caddyfile: Map<address line, body lines>. */
function topLevelBlocks(lines) {
  const blocks = new Map();
  let open = null;
  let depth = 0;
  for (const line of lines) {
    if (depth === 0) {
      assert.match(line, /\{$/, `top-level line must open a block: ${line}`);
      open = line.replace(/\s*\{$/, "");
      blocks.set(open, []);
    } else if (!(depth === 1 && line === "}")) {
      blocks.get(open).push(line);
    }
    depth += (line.match(/\{(?![a-z_.]+\})/g) ?? []).length;
    depth -= (line.match(/(?<!\{[a-z_.]+)\}/g) ?? []).length;
  }
  return blocks;
}

const caddyfile = topLevelBlocks(directives(read("caddy/Caddyfile"), "Caddyfile"));
const proxy = directives(read("caddy/mode-proxy.caddy"), "mode-proxy.caddy");
const allowlist = directives(read("caddy/mode-allowlist.caddy"), "mode-allowlist.caddy");
const maintenance = directives(read("caddy/mode-maintenance.caddy"), "mode-maintenance.caddy");

test("Caddy listens only on 127.0.0.1:8080 and trusts CF-Connecting-IP from cloudflared", () => {
  assert.deepEqual([...caddyfile.keys()], [
    "",
    "http://us.ggd2l.com:8080",
    "http://eu.ggd2l.com:8080",
    "http://ggd2l.com:8080, http://www.ggd2l.com:8080",
    "http://:8080",
  ]);
  assert.deepEqual(caddyfile.get(""), [
    "admin unix//run/caddy/admin.sock|0600",
    "auto_https off",
    "servers {",
    "trusted_proxies static 127.0.0.1/32 ::1/128",
    "client_ip_headers CF-Connecting-IP",
    "}",
  ]);
  for (const [address, body] of caddyfile)
    if (address) assert.equal(body[0], "bind 127.0.0.1", `${address} binds loopback only`);
});

// 2026-10-19 audit: on localhost:2019 the admin API took POST /load from any
// local user with no authentication, so either league's slot, the bot or a
// build could reroute both leagues. It is a socket only caddy and root open.
test("Caddy's admin API is a socket only caddy and root can open, in the folder systemd makes for it", () => {
  const admin = caddyfile.get("").filter((line) => line.startsWith("admin "));
  assert.equal(admin.length, 1);
  const match = /^admin unix\/(\/run\/([a-z]+)\/[a-z]+\.sock)\|(0[0-7]{3})$/.exec(admin[0]);
  assert.ok(match, `the admin API is a unix socket with an explicit mode, never a TCP address: ${admin[0]}`);
  const [, socket, folder, mode] = match;
  assert.equal(Number.parseInt(mode, 8) & 0o077, 0, "the socket has no group or other access");
  // Without the suffix Caddy makes the socket 0200; the folder is the second
  // fence, and systemd makes it at each start for the unit's user (caddy).
  const dropIn = read("systemd/caddy.service.d/10-ggd2l.conf");
  assert.match(dropIn, new RegExp(`^RuntimeDirectory=${folder}$`, "m"));
  assert.match(dropIn, /^RuntimeDirectoryMode=0700$/m);
  // install-kit.sh decides between a reload and a restart by that socket.
  const installKit = read("install-kit.sh");
  assert.equal(/^CADDY_ADMIN_SOCKET=(.*)$/m.exec(installKit)?.[1], socket);
  // Nothing the kit runs calls the admin API itself: every reload is the
  // unit's ExecReload (`caddy reload --config /etc/caddy/Caddyfile`, which
  // reads the address from the Caddyfile), through systemctl. (install-kit.sh's
  // closing checks are printed for the operator, not run.)
  const files = [
    "install-kit.sh", "provision-base.sh", "provision-ggd2l.sh",
    ...["caddy-modes.mjs", "releases.mjs", "status.mjs", "ggd2l-agent.mjs"].map((f) => `agent/${f}`),
    ...["heartbeat.sh", "discord-alert.mjs"].map((f) => `backup/${f}`),
  ];
  for (const file of files) {
    const code = read(file).split("\nCheck (as root):\n")[0].replace(/^\s*(#|\/\/|\*).*$/gm, "");
    assert.doesNotMatch(code, /:2019\b|caddy reload|--address|\/load\b|\/config\/|unix-socket/, `${file} calls Caddy's admin API`);
  }
});

test("each league block serves its own static union and imports its own mode file", () => {
  for (const [lg, other] of [["us", "eu"], ["eu", "us"]]) {
    const body = caddyfile.get(`http://${lg}.ggd2l.com:8080`);
    const text = body.join("\n");
    assert.ok(text.includes(`output file /var/log/caddy/${lg}.access.json {`));
    assert.ok(text.includes("roll_size 50MiB\nroll_keep 10\n}\nformat json"));
    assert.ok(text.includes(`handle /_next/static/* {\nroot * /srv/ggd2l/${lg}/static\n`));
    assert.ok(text.includes('@exists file\nheader @exists Cache-Control "public, max-age=31536000, immutable"'));
    assert.ok(text.includes(`handle {\nimport /etc/caddy/ggd2l/${lg}-mode.caddy\n}`));
    assert.doesNotMatch(text, new RegExp(`\\b${other}\\b`), `the ${lg} block never names ${other}`);
  }
  // The two league blocks differ only in the league's name.
  assert.equal(
    caddyfile.get("http://us.ggd2l.com:8080").join("\n").replaceAll("us", "LG"),
    caddyfile.get("http://eu.ggd2l.com:8080").join("\n").replaceAll("eu", "LG"),
  );
});

test("the bare domain and www redirect to the US league with path and query", () => {
  const body = caddyfile.get("http://ggd2l.com:8080, http://www.ggd2l.com:8080");
  assert.equal(body.at(-1), "redir https://us.ggd2l.com{uri} 302");
  assert.ok(body.includes("output file /var/log/caddy/apex.access.json {"));
  assert.deepEqual(caddyfile.get("http://:8080"), ["bind 127.0.0.1", "respond 404"]);
});

const PROXY_BLOCK = [
  "reverse_proxy 127.0.0.1:__PORT__ {",
  "header_up -X-Vercel-Forwarded-For",
  "header_up -X-Real-IP",
  "header_up -X-Middleware-Subrequest",
  "header_up X-Forwarded-Proto https",
  "header_up X-Forwarded-For {client_ip}",
  "flush_interval -1",
  "transport http {",
  "keepalive 60s",
  "}",
  "}",
];

test("proxy mode strips edge headers, streams, and keeps upstream keepalive under Node's", () => {
  assert.deepEqual(proxy, PROXY_BLOCK);
  const unit = read("systemd/ggd2l-us@.service");
  const nodeKeepAlive = Number(/--keepAliveTimeout (\d+)/.exec(unit)[1]);
  assert.ok(60_000 < nodeKeepAlive, "Caddy must drop an idle upstream connection before Node does");
});

test("maintenance mode answers every method with 503 and a retry hint", () => {
  assert.deepEqual(maintenance, [
    "header Retry-After 600",
    "header Cache-Control no-store",
    'header X-Robots-Tag "noindex, nofollow"',
    "@write not method GET HEAD",
    'respond @write "GGD2L is under maintenance. Check the league Discord for updates." 503',
    "root * /srv/ggd2l/www",
    "rewrite * /maintenance.html",
    "file_server {",
    "status 503",
    "}",
  ]);
});

test("allowlist mode proxies only allow.caddy's addresses and shows everyone else maintenance", () => {
  assert.equal(allowlist[0], "import /etc/caddy/ggd2l/allow.caddy");
  assert.deepEqual(allowlist.slice(1, 3), ["handle @allowed {", 'header X-Robots-Tag "noindex, nofollow"']);
  assert.deepEqual(allowlist.slice(3, 3 + PROXY_BLOCK.length), PROXY_BLOCK);
  assert.deepEqual(allowlist.slice(3 + PROXY_BLOCK.length), ["}", "handle {", ...maintenance, "}"]);
});

// install-kit.sh seeds a new league with mode-maintenance.caddy, and from then
// on the release agent renders the mode files, so the two must agree line for
// line (comments aside). The agent belongs to another package and sits beside
// these files only once both are merged.
const AGENT_MODES = path.join(SELFHOST, "agent", "caddy-modes.mjs");

test("the release agent renders exactly these mode files",
  { skip: !existsSync(AGENT_MODES) && "the release agent is not on this branch" }, async () => {
    const { renderMode } = await import(pathToFileURL(AGENT_MODES).href);
    const port = 3011;
    const withPort = (lines) => lines.map((line) => line.replaceAll("__PORT__", String(port)));
    assert.deepEqual(directives(renderMode("maintenance"), "maintenance render"), maintenance);
    assert.deepEqual(directives(renderMode("proxy", { port }), "proxy render"), withPort(proxy));
    assert.deepEqual(directives(renderMode("allowlist", { port }), "allowlist render"), withPort(allowlist));
  });

test("the tunnel routes exactly Caddy's four hostnames to 127.0.0.1:8080 with their own Host", () => {
  const template = read("cloudflared/config.yml.template");
  assert.match(template, /^tunnel: <TUNNEL_UUID>$/m);
  assert.match(template, /^credentials-file: \/etc\/cloudflared\/<TUNNEL_UUID>\.json$/m);
  const rules = [...template.matchAll(/^  - hostname: (\S+)\n    service: (\S+)\n    originRequest: \{ httpHostHeader: (\S+) \}$/gm)];
  assert.deepEqual(rules.map((r) => r[1]), HOSTS);
  for (const [, host, service, hostHeader] of rules) {
    assert.equal(service, "http://127.0.0.1:8080");
    assert.equal(hostHeader, host);
  }
  assert.match(template, /^  - service: http_status:404\n$/m, "anything else is a 404 from cloudflared");
  const caddyHosts = [...caddyfile.keys()].join(",").match(/[a-z.]*ggd2l\.com/g);
  assert.deepEqual(caddyHosts, HOSTS, "Caddy serves the same four hostnames");
});

test("the maintenance page is plain GGD2L text that points players to Discord", () => {
  const html = read("caddy/maintenance.html");
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>GGD2L is under maintenance<\/title>/);
  assert.match(html, /Discord/);
  assert.match(html, /name="robots" content="noindex, nofollow"/);
  assert.doesNotMatch(html, /LD2L/, "the league is GGD2L in anything a player sees");
  assert.doesNotMatch(html, /<script|https?:\/\//, "no scripts and nothing fetched from elsewhere");
});
