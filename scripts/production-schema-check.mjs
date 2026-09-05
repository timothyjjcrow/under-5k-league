import { inspectPostflightDatabase } from "./migration-postflight.mjs";
import { productionEnvironmentRequired } from "./vercel-environment.mjs";
import { executeInstanceSql, instanceIdentitySql } from "./instance-database.mjs";

async function run() {
  if (!productionEnvironmentRequired(process.env)) {
    console.log(
      `Production schema attestation skipped for VERCEL_ENV=${process.env.VERCEL_ENV ?? "(unset)"}.`,
    );
    return;
  }

  const { schema, migrationCount, nativeObjectCount } =
    await inspectPostflightDatabase();
  executeInstanceSql(instanceIdentitySql(process.env));
  console.log(
    `Production schema attestation passed in schema ${schema}: ${migrationCount} migrations and ${nativeObjectCount} native objects verified.`,
  );
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
