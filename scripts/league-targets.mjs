/** One application, two isolated deployments. No credentials belong here. */
export const VERCEL_TEAM_ID = "team_AAPVeTcNEWDyESODtRIjzyry";
export const VERCEL_SCOPE = "timothyjjcrows-projects";
export const RELEASE_REPOSITORY = "timothyjjcrow/under-5k-league";
export const LEAGUE_TARGETS = Object.freeze([
  Object.freeze({ region: "us", projectId: "prj_zMiAE147RH8NxH68lvchCnL66GIr", name: "under-4.5k-league", origin: "https://ggd2l.vercel.app", functionRegion: "iad1", tokenEnv: "VERCEL_US_TOKEN" }),
  Object.freeze({ region: "eu", projectId: "prj_WQT8SiXKGPd1CB2zQXzmdaO2BFr9", name: "ggd2l-europe", origin: "https://ggd2l-europe.vercel.app", functionRegion: "fra1", tokenEnv: "VERCEL_EU_TOKEN" }),
]);

export function assertDeployment(target, deployment, sha, production = true) {
  const actualSha = deployment.meta?.gitCommitSha ?? deployment.meta?.githubCommitSha;
  if (deployment.projectId !== target.projectId || actualSha !== sha ||
      (deployment.readyState ?? deployment.state) !== "READY" ||
      (production ? deployment.target !== "production" : deployment.target === "production") ||
      !deployment.regions?.includes(target.functionRegion)) {
    throw new Error(`${target.region}: deployment identity, version, state or region does not match the reviewed release`);
  }
}

export function assertReleaseInfo(target, info, sha) {
  if (info.ok !== true || info.region !== target.region || info.commit !== sha)
    throw new Error(`${target.region}: the site does not report the reviewed shared version and league`);
}

/** Both stages are checked before promotion. Compensate a partial promotion;
 * never overwrite a newer deployment belonging to another release. */
export async function promotePair({ targets = LEAGUE_TARGETS, bases, candidates, readLive, promote, verify, finalize = async () => {}, record = () => {} }) {
  for (const target of targets) {
    if ((await readLive(target)).id !== bases[target.region].id)
      throw new Error(`${target.region}: production changed during staging; re-plan the release`);
  }
  const attempted = [];
  try {
    for (const target of targets) {
      attempted.push(target);
      await promote(target, candidates[target.region].id);
      await verify(target, candidates[target.region]);
      record({ region: target.region, action: "promoted", deploymentId: candidates[target.region].id });
    }
    await finalize();
  } catch {
    const recovery = [];
    for (const target of attempted.toReversed()) {
      try {
        const live = await readLive(target);
        if (live.id === candidates[target.region].id) {
          await promote(target, bases[target.region].id);
          if ((await readLive(target)).id !== bases[target.region].id) throw new Error("rollback not confirmed");
          recovery.push(`${target.region}: previous deployment restored`);
        } else if (live.id === bases[target.region].id) {
          recovery.push(`${target.region}: previous deployment unchanged`);
        } else {
          recovery.push(`${target.region}: newer external deployment left untouched; operator review required`);
        }
      } catch {
        recovery.push(`${target.region}: rollback needs operator review`);
      }
    }
    recovery.forEach((message) => record({ action: "recovery", message }));
    throw new Error(`Paired promotion failed. ${recovery.join("; ")}`);
  }
}
