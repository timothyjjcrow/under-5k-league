import { pathToFileURL } from "node:url";
import path from "node:path";
import { LEAGUE_TARGETS, VERCEL_TEAM_ID } from "./league-targets.mjs";

/** Project-scoped REST operations avoid the CLI's account-wide owner lookups. */
export function projectProvider(target, token, request = fetch) {
  if (!token) throw new Error(`${target.region}: deployment credential is missing`);
  let bypass;
  const json = async (url, init = {}) => {
    let response;
    try {
      response = await request(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(45_000) });
    } catch { throw new Error(`${target.region}: provider request failed`); }
    if (!response.ok) throw new Error(`${target.region}: ${new URL(url).pathname} failed (HTTP ${response.status})`);
    const text = await response.text();
    try { return text ? JSON.parse(text) : null; }
    catch { throw new Error(`${target.region}: provider returned an invalid response`); }
  };
  const api = (endpoint, init) => json(`https://api.vercel.com${endpoint}${endpoint.includes("?") ? "&" : "?"}teamId=${VERCEL_TEAM_ID}`, init);
  return {
    api,
    async probe(url, pathname) {
      if (!pathname.startsWith("/") || pathname.startsWith("//") || pathname.includes("\\"))
        throw new Error(`${target.region}: invalid probe path`);
      const host = new URL(url);
      if (host.protocol !== "https:" || host.username || host.password ||
          !(host.origin === target.origin || host.hostname.endsWith(".vercel.app")))
        throw new Error(`${target.region}: unexpected deployment origin`);
      if (bypass === undefined) {
        const project = await api(`/v9/projects/${target.projectId}`);
        if (project.id !== target.projectId) throw new Error(`${target.region}: project identity mismatch`);
        bypass = Object.keys(project.protectionBypass ?? {}).find((key) => project.protectionBypass[key].scope === "automation-bypass");
        if (!bypass) throw new Error(`${target.region}: configure the project's automation protection credential`);
      }
      let response;
      try {
        response = await request(new URL(pathname, host), { headers: { "x-vercel-protection-bypass": bypass }, redirect: "error", signal: AbortSignal.timeout(45_000), cache: "no-store" });
      } catch { throw new Error(`${target.region}: deployment probe failed`); }
      if (!response.ok) throw new Error(`${target.region}: deployment probe failed (HTTP ${response.status})`);
      return response.text();
    },
    promote(id) {
      if (!/^dpl_[a-zA-Z0-9]+$/.test(id)) throw new Error("Invalid deployment ID");
      return api(`/v10/projects/${target.projectId}/promote/${id}`, { method: "POST", body: "{}" });
    },
    async logs(id, since) {
      const logs = [];
      for (let page = 0; page < 5; page++) {
        const query = new URLSearchParams({ projectId: target.projectId, ownerId: VERCEL_TEAM_ID, teamId: VERCEL_TEAM_ID, deploymentId: id, startDate: String(since), endDate: String(Date.now()), page: String(page) });
        const data = await json(`https://vercel.com/api/logs/request-logs?${query}`);
        if (!Array.isArray(data?.rows)) throw new Error(`${target.region}: invalid runtime log response`);
        for (const row of data.rows) {
          if (row.deploymentId !== id) throw new Error(`${target.region}: unexpected deployment in runtime logs`);
          logs.push({ timestamp: Date.parse(row.timestamp), responseStatusCode: row.statusCode, requestPath: row.requestPath,
            level: row.logs?.some((entry) => entry.level === "fatal" || entry.level === "error") ? "error" : "info" });
        }
        if (!data.hasMoreRows) return logs;
      }
      throw new Error(`${target.region}: runtime log window exceeds the release verification limit`);
    },
  };
}

// Read-only credential verification can run before the exact-commit CI gate.
export async function checkReleaseAccess(env = process.env, { includeLogs = true } = {}) {
  for (const target of LEAGUE_TARGETS) {
    const provider = projectProvider(target, env[target.tokenEnv]);
    const alias = await provider.api(`/v4/aliases/${new URL(target.origin).hostname}`);
    if (alias.projectId !== target.projectId) throw new Error(`${target.region}: canonical project mismatch`);
    const id = alias.deploymentId ?? alias.deployment?.id;
    if (!id) throw new Error(`${target.region}: canonical deployment is missing`);
    if (JSON.parse(await provider.probe(target.origin, "/api/health/live")).ok !== true)
      throw new Error(`${target.region}: liveness failed`);
    if (includeLogs) await provider.logs(id, Date.now() - 5 * 60_000);
    console.log(`${target.region}: project metadata and protected probes${includeLogs ? ", plus runtime-log access," : ""} verified`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  checkReleaseAccess(process.env, { includeLogs: !process.argv.includes("--previews-only") }).catch((error) => { console.error(error.message); process.exitCode = 1; });
