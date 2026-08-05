import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const OPERATIONS = readFileSync(
  path.resolve(process.cwd(), "docs/PRODUCTION-OPERATIONS.md"),
  "utf8",
);

function between(startMarker: string, endMarker: string): string {
  const start = OPERATIONS.indexOf(startMarker);
  const end = OPERATIONS.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`Missing operations runbook boundary: ${startMarker}`);
  }
  return OPERATIONS.slice(start, end);
}

const OWNERS = between("## Required owners", "## Launch evidence record");
const RUNBOOK = between(
  "## Data correction and retention",
  "## Controlled promotion",
);
const INTAKE = RUNBOOK.slice(
  RUNBOOK.indexOf("### Intake, verification, and case handling"),
  RUNBOOK.indexOf("### Scope and fulfillment"),
);
const FULFILLMENT = RUNBOOK.slice(
  RUNBOOK.indexOf("### Scope and fulfillment"),
  RUNBOOK.indexOf("### Retention and restoration replay"),
);
const RETENTION = RUNBOOK.slice(
  RUNBOOK.indexOf("### Retention and restoration replay"),
  RUNBOOK.indexOf("### Pre-launch data-handling tabletop"),
);
const TABLETOP = RUNBOOK.slice(
  RUNBOOK.indexOf("### Pre-launch data-handling tabletop"),
);

const compact = (sourceText: string) => sourceText.replace(/\s+/g, " ");

describe("production data-correction operations contract", () => {
  it("keeps independent primary/deputy ownership and private case handling", () => {
    const owners = compact(OWNERS);
    expect(owners).toMatch(/data correction owner and deputy/i);
    expect(owners).toMatch(/independent MFA access/i);
    expect(owners).toMatch(/deputy must be able to continue/i);
    expect(compact(INTAKE)).toMatch(
      /(?:access-controlled|private)[^.]{0,80}case register/i,
    );
  });

  it("forbids sensitive authentication material as identity proof", () => {
    const prohibition = compact(INTAKE).match(
      /(?:never|do not|must not) (?:request|collect)[^.]*government (?:identity document|ID)/i,
    )?.[0];

    expect(prohibition).toBeDefined();
    for (const forbidden of [
      /password/i,
      /(?:2FA|two-factor)/i,
      /API key/i,
      /government (?:identity document|ID)/i,
    ]) {
      expect(prohibition).toMatch(forbidden);
    }
  });

  it("requires a complete source inventory and a subject-only response", () => {
    const fulfillment = compact(FULFILLMENT);
    expect(fulfillment).toMatch(/source inventory/i);
    for (const dataSource of [
      /database/i,
      /backups?\b|PITR/i,
      /application logs/i,
      /Discord/i,
      /Steam/i,
      /OpenDota/i,
    ]) {
      expect(fulfillment).toMatch(dataSource);
    }

    expect(fulfillment).toMatch(/subject-specific/i);
    expect(fulfillment).toMatch(
      /season (?:JSON|archive)[^.]{0,180}(?:never|must not|not be)[^.]{0,120}(?:personal-data )?export/i,
    );
  });

  it("requires two-person review and disposable-clone rehearsal", () => {
    const fulfillment = compact(FULFILLMENT);
    expect(fulfillment).toMatch(/database owner and data correction owner must review/i);
    expect(fulfillment).toMatch(/rehearse[^.]*disposable clone/i);
    expect(fulfillment).toMatch(/correction or de-identification/i);
  });

  it("makes restore replay and failed handling evidence release stops", () => {
    const retention = compact(RETENTION);
    const tabletop = compact(TABLETOP);
    expect(retention).toMatch(/before promoting any restored snapshot/i);
    expect(retention).toMatch(/replay register/i);
    expect(retention).toMatch(/reapply and verify/i);

    for (const stopCondition of [
      /unverified contact channel/i,
      /inaccessible deputy/i,
      /storage\/encryption[^.]*retention evidence/i,
      /unsafe subject extraction/i,
      /failed rehearsal/i,
      /incomplete restore replay/i,
    ]) {
      expect(tabletop).toMatch(stopCondition);
    }
    expect(tabletop).toMatch(/release stop[^.]*traffic opens/i);
  });
});
