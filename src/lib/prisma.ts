import { Prisma, PrismaClient } from "@prisma/client";
import { prismaLogLevels } from "./prisma-log-policy";
import { databaseDiagnostics } from "./db-observability";
import { createPoolMetricsReader } from "./pool-diagnostics";
import { observeOperation } from "./observe-operation";

// One client, and so one connection pool, per process, in every environment.
// Next loads this module once per server bundle (route handlers and pages each
// get their own instance), so a client held only in the module opened a pool
// per bundle: two per `next start` process on the box (16 sockets at
// connection_limit=8, measured 2026-10-17). globalThis is shared by every
// bundle in the process, and by development reloads.
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaMetricReaders?: WeakMap<PrismaClient, ReturnType<typeof createPoolMetricsReader>>;
};
// Shared too, so the process keeps at most one outstanding engine sample.
const metricReaders = globalForPrisma.prismaMetricReaders ??= new WeakMap();
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

export const prisma = globalForPrisma.prisma ??= createClient();

export async function readPoolDiagnostics() {
  return poolReader(prisma)();
}
