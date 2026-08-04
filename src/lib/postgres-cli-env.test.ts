import { describe, expect, it, vi } from "vitest";
import { postgresCliEnv } from "./postgres-cli-env.mjs";

describe("PostgreSQL command-line environment", () => {
  it("keeps credentials out of URLs and clears inherited connection targets", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://wrong:wrong@wrong.example/wrong");
    vi.stubEnv("PGHOST", "wrong.example");
    vi.stubEnv("PGDATABASE", "wrong");
    const env = postgresCliEnv(
      "postgresql://league:very%20secret@localhost:5432/ld2l_test?sslmode=require&pgbouncer=true",
    );
    expect(env).toMatchObject({
      PGHOST: "localhost",
      PGPORT: "5432",
      PGDATABASE: "ld2l_test",
      PGUSER: "league",
      PGPASSWORD: "very secret",
      PGSSLMODE: "require",
    });
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("DIRECT_URL");
  });

  it("permits only a simple explicit maintenance database override", () => {
    expect(
      postgresCliEnv("postgresql://league@localhost/ld2l_test", {
        database: "postgres",
      }).PGDATABASE,
    ).toBe("postgres");
    expect(() =>
      postgresCliEnv("postgresql://league@localhost/ld2l_test", {
        database: "other;DROP DATABASE league",
      }),
    ).toThrow(/unsupported characters/);
  });

  it("rejects unknown URL options instead of silently changing semantics", () => {
    expect(() =>
      postgresCliEnv(
        "postgresql://league@localhost/ld2l_test?surprise_option=true",
      ),
    ).toThrow(/unsupported PostgreSQL URL parameter/);
  });
});
