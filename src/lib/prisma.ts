import { Prisma, PrismaClient } from "@prisma/client";
import { prismaLogLevels } from "./prisma-log-policy";
import { databaseDiagnostics } from "./db-observability";
import { createPoolMetricsReader } from "./pool-diagnostics";
import { observeOperation } from "./observe-operation";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};
const metricReaders = new WeakMap<PrismaClient, ReturnType<typeof createPoolMetricsReader>>();
function poolReader(client: PrismaClient) {
  let reader = metricReaders.get(client);
  if (!reader) {
    reader = createPoolMetricsReader(() => client.$metrics.json());
    metricReaders.set(client, reader);
  }
  return reader;
}

function createClient() {
  databaseDiagnostics.allowModels(Object.values(Prisma.ModelName));
  const client = new PrismaClient({
    log: prismaLogLevels(process.env.NODE_ENV),
  });
  client.$use((params, next) => observeOperation(
    () => next(params),
    async ({ elapsedMs, failed, error }) => {
        databaseDiagnostics.record(params.model, params.action, elapsedMs,
          failed ? error ?? { code: "UNKNOWN" } : undefined);
        // At most one bounded summary per active process/minute. No observer
        // failure may replace the result or error of the original query.
        const sample = databaseDiagnostics.drain(Date.now());
        if (sample && process.env.NODE_ENV === "production") {
          const poolSinceProcessStart = await poolReader(client)();
          console.info(JSON.stringify({ event: "database-performance", ...sample, poolSinceProcessStart }));
        }
    },
  ));
  return client;
}

export const prisma = globalForPrisma.prisma ?? createClient();

export async function readPoolDiagnostics() {
  return poolReader(prisma)();
}

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
