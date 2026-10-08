import { inspectPostflightDatabase } from "./migration-postflight.mjs";
import {
  previewDatabaseAttestationRequired,
  productionEnvironmentRequired,
} from "./vercel-environment.mjs";
import { executeInstanceSql, instanceIdentitySql } from "./instance-database.mjs";

async function run() {
  if (productionEnvironmentRequired(process.env)) {
    const { schema, migrationCount, nativeObjectCount } =
      await inspectPostflightDatabase();
    executeInstanceSql(instanceIdentitySql(process.env));
    console.log(
      `Production schema attestation passed in schema ${schema}: ${migrationCount} migrations and ${nativeObjectCount} native objects verified.`,
    );
    return;
  }

  // The same read-only attestation for a Preview's own database. Nothing
  // migrates Preview databases automatically, so a Preview that is behind
  // stops here instead of serving pages that fail at runtime.
  if (previewDatabaseAttestationRequired(process.env)) {
    let result;
    try {
      result = await inspectPostflightDatabase();
    } catch (error) {
      throw new Error(
        `Preview database attestation failed: ${error instanceof Error ? error.message : error}\n` +
          "A Preview builds only on a reachable Preview database with every committed migration; to bring it up to date, see docs/RELEASING.md, Appendix B.",
      );
    }
    console.log(
      `Preview database attestation passed in schema ${result.schema}: ${result.migrationCount} migrations and ${result.nativeObjectCount} native objects verified.`,
    );
    return;
  }

  console.log(
    `Production schema attestation skipped for VERCEL_ENV=${process.env.VERCEL_ENV ?? "(unset)"}.`,
  );
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
