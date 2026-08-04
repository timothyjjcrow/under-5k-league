import { describe, expect, it } from "vitest";
import { postgresDatabaseIdentity } from "./postgres-identity.mjs";

describe("PostgreSQL logical database identity", () => {
  it("normalizes Neon pooled/direct hosts and ignores credentials/ports/options", () => {
    const pooled = postgresDatabaseIdentity(
      "postgresql://league:pooled@ep-blue-pooler.us-east-2.aws.neon.tech:6543/ld2l?sslmode=require&pgbouncer=true",
    );
    const direct = postgresDatabaseIdentity(
      "postgres://league:direct@ep-blue.us-east-2.aws.neon.tech:5432/ld2l?sslmode=verify-full",
    );
    expect(pooled).toBe(direct);
    expect(pooled).not.toContain("pooled");
    expect(pooled).not.toContain("direct");
  });

  it("normalizes Supabase's project-ref pooler identity", () => {
    expect(
      postgresDatabaseIdentity(
        "postgresql://postgres.projectref:pool@aws-0-us-west-1.pooler.supabase.com:6543/postgres",
      ),
    ).toBe(
      postgresDatabaseIdentity(
        "postgresql://postgres:direct@db.projectref.supabase.co:5432/postgres",
      ),
    );
  });

  it("keeps user, database and endpoint differences distinct", () => {
    const base = postgresDatabaseIdentity(
      "postgresql://league:x@ep-blue.us.neon.tech/ld2l",
    );
    expect(
      postgresDatabaseIdentity("postgresql://other:x@ep-blue.us.neon.tech/ld2l"),
    ).not.toBe(base);
    expect(
      postgresDatabaseIdentity("postgresql://league:x@ep-blue.us.neon.tech/other"),
    ).not.toBe(base);
    expect(
      postgresDatabaseIdentity("postgresql://league:x@ep-red.us.neon.tech/ld2l"),
    ).not.toBe(base);
  });

  it("rejects malformed, non-Postgres and userless URLs", () => {
    expect(postgresDatabaseIdentity("file:./dev.db")).toBeNull();
    expect(postgresDatabaseIdentity("postgresql://host/database")).toBeNull();
    expect(postgresDatabaseIdentity("not a url")).toBeNull();
  });
});
