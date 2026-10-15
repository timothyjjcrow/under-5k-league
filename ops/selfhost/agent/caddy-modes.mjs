// Caddy mode files (design §1.7). The Caddyfile imports
// /etc/caddy/ggd2l/<lg>-mode.caddy inside each league's catch-all handle, and
// the agent rewrites that file in one of three forms:
//
//   proxy        the live slot, for everyone
//   allowlist    the live slot for the addresses in allow.caddy, maintenance for the rest
//   maintenance  the static 503 page
//
// Every change follows one path: write <file>.new, keep <file>.prev, mv the new
// file into place, `caddy validate`; on failure mv .prev back. Only a
// validated file is ever reloaded.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { AgentError, BIN } from "./layout.mjs";

export const MODES = Object.freeze(["proxy", "allowlist", "maintenance"]);
const HEADER = "# Written by ggd2l-agent. Change it with `ggd2l-agent mode`, never by hand.";

function proxyBlock(port, indent) {
  const pad = (n) => indent + "\t".repeat(n);
  return [
    `${pad(0)}reverse_proxy 127.0.0.1:${port} {`,
    `${pad(1)}header_up -X-Vercel-Forwarded-For`,
    `${pad(1)}header_up -X-Real-IP`,
    `${pad(1)}header_up -X-Middleware-Subrequest`,
    `${pad(1)}header_up X-Forwarded-Proto https`,
    `${pad(1)}header_up X-Forwarded-For {client_ip}`,
    `${pad(1)}flush_interval -1`,
    `${pad(1)}transport http {`,
    `${pad(2)}keepalive 60s`,
    `${pad(1)}}`,
    `${pad(0)}}`,
  ];
}

function maintenanceBlock(indent, wwwRoot) {
  return [
    `${indent}header Retry-After 600`,
    `${indent}header Cache-Control no-store`,
    `${indent}root * ${wwwRoot}`,
    `${indent}rewrite * /maintenance.html`,
    `${indent}file_server {`,
    `${indent}\tstatus 503`,
    `${indent}}`,
  ];
}

/** The text of one league's mode file. Headers are inline; no snippet imports. */
export function renderMode(mode, { port, allowFile = "/etc/caddy/ggd2l/allow.caddy", wwwRoot = "/srv/ggd2l/www" } = {}) {
  const lines = [HEADER, `# mode: ${mode}`];
  if (mode === "proxy") {
    if (!Number.isInteger(port)) throw new AgentError("no_live");
    lines.push(...proxyBlock(port, ""));
  } else if (mode === "allowlist") {
    if (!Number.isInteger(port)) throw new AgentError("no_live");
    lines.push(
      `import ${allowFile}`,
      "handle @allowed {",
      '\theader X-Robots-Tag "noindex, nofollow"',
      ...proxyBlock(port, "\t"),
      "}",
      "handle {",
      ...maintenanceBlock("\t", wwwRoot),
      "}",
    );
  } else if (mode === "maintenance") {
    lines.push(...maintenanceBlock("", wwwRoot));
  } else {
    throw new AgentError("bad_mode");
  }
  return `${lines.join("\n")}\n`;
}

/** allow.caddy: the one named matcher the allowlist mode files import. */
export function renderAllow(ips) {
  return `${HEADER}\n@allowed client_ip ${ips.join(" ")}\n`;
}

/** Read a mode file back: its mode and the slot port it proxies to, if any. */
export function readMode(text) {
  if (typeof text !== "string") return { mode: null, port: null };
  const ports = [...text.matchAll(/reverse_proxy\s+127\.0\.0\.1:(\d+)/g)].map((m) => Number(m[1]));
  const port = ports.length === 1 ? ports[0] : null;
  if (/^\s*import\s+\S*allow\.caddy\s*$/m.test(text) && port) return { mode: "allowlist", port };
  if (port) return { mode: "proxy", port };
  if (ports.length === 0 && /maintenance\.html/.test(text)) return { mode: "maintenance", port: null };
  return { mode: null, port: null };
}

export function readModeFile(file) {
  try {
    return readMode(readFileSync(file, "utf8"));
  } catch {
    return { mode: null, port: null };
  }
}

/**
 * Swap one Caddy file and make Caddy load it, or leave everything as it was.
 * Resolves only once the reload succeeded; otherwise the old file is back in
 * place (re-reloaded if a reload had been attempted) and it throws.
 */
export async function applyCaddyFile({ runner, file, text, caddyfile }) {
  const next = `${file}.new`;
  const prev = `${file}.prev`;
  rmSync(next, { force: true });
  writeFileSync(next, text, { mode: 0o640 });
  // Caddy reads its config as the caddy user; allow.caddy holds an address.
  if ((await runner.run(BIN.chown, ["root:caddy", next])).code !== 0) {
    rmSync(next, { force: true });
    throw new AgentError("caddy_write_failed");
  }
  const hadOld = existsSync(file);
  if (hadOld) copyFileSync(file, prev);
  renameSync(next, file);

  const restore = () => {
    if (hadOld) copyFileSync(prev, file);
    else rmSync(file, { force: true });
  };

  const validated = await runner.run(BIN.caddy, ["validate", "--config", caddyfile, "--adapter", "caddyfile"]);
  if (validated.code !== 0) {
    restore();
    throw new AgentError("caddy_invalid");
  }
  const reloaded = await runner.run(BIN.systemctl, ["reload", "caddy.service"]);
  if (reloaded.code !== 0) {
    restore();
    // Best effort: put the running Caddy back on the restored file.
    await runner.run(BIN.systemctl, ["reload", "caddy.service"]);
    throw new AgentError("caddy_reload_failed");
  }
}
