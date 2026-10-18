import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in client: constructing a real one per case would load the query
// engine, and only the count and the identity matter here.
const engine = vi.hoisted(() => ({ clients: 0, samples: 0, release: () => {} }));
vi.mock("@prisma/client", () => ({
  Prisma: { ModelName: { User: "User" } },
  PrismaClient: class {
    $metrics = {
      json: () => {
        engine.samples += 1;
        return new Promise((resolve) => {
          engine.release = () => resolve({ counters: [], gauges: [], histograms: [] });
        });
      },
    };
    constructor() {
      engine.clients += 1;
    }
    $use() {}
  },
}));

const host = globalThis as { prisma?: unknown; prismaMetricReaders?: unknown };

/** A fresh module instance, as each Next server bundle loads its own. */
async function loadInstance() {
  vi.resetModules();
  return import("./prisma");
}

describe("the Prisma client", () => {
  const saved = { prisma: host.prisma, readers: host.prismaMetricReaders };
  beforeEach(() => {
    delete host.prisma;
    delete host.prismaMetricReaders;
    Object.assign(engine, { clients: 0, samples: 0 });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    host.prisma = saved.prisma;
    host.prismaMetricReaders = saved.readers;
  });

  // Production is the case that matters: `next start` on the box held two
  // pools per process when only development shared the client.
  for (const nodeEnv of ["production", "development", "test"]) {
    it(`is one client, so one pool, across module instances in ${nodeEnv}`, async () => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      const routeHandlers = await loadInstance();
      const pages = await loadInstance();
      expect(pages.prisma).toBe(routeHandlers.prisma);
      expect(engine.clients).toBe(1);
    });
  }

  it("keeps at most one engine sample outstanding across module instances", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const routeHandlers = await loadInstance();
    const pages = await loadInstance();
    const reads = Promise.all([routeHandlers.readPoolDiagnostics(), pages.readPoolDiagnostics()]);
    engine.release();
    await reads;
    expect(engine.samples).toBe(1);
  });
});
