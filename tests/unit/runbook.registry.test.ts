import { describe, expect, it } from "vitest";
import { RunbookRegistry } from "../../src/runbooks/runbook.registry.js";
import type { Runbook } from "../../src/runbooks/runbook.types.js";
import type { NormalizedAlert } from "../../src/ingest/alert.types.js";
import { FakeAction } from "../helpers/fakes.js";

function alert(overrides: Partial<NormalizedAlert> = {}): NormalizedAlert {
  return {
    id: "a1",
    name: "OOMKilled",
    status: "firing",
    severity: "critical",
    service: "api",
    namespace: "prod",
    summary: null,
    labels: { alertname: "OOMKilled", severity: "critical", team: "core" },
    startsAt: "2026-07-13T10:00:00Z",
    ...overrides,
  };
}

function runbook(overrides: Partial<Runbook> = {}): Runbook {
  return {
    id: "rb-1",
    description: "test runbook",
    matcher: {},
    steps: [{ actionId: "act-1", params: {} }],
    ...overrides,
  };
}

describe("RunbookRegistry", () => {
  it("rejects duplicate action ids", () => {
    const registry = new RunbookRegistry();
    registry.registerAction(new FakeAction("act-1", "read-only"));
    expect(() =>
      registry.registerAction(new FakeAction("act-1", "read-only"))
    ).toThrow(/Duplicate action id/);
  });

  it("rejects runbooks referencing unknown actions", () => {
    const registry = new RunbookRegistry();
    expect(() => registry.registerRunbook(runbook())).toThrow(
      /unknown action "act-1"/
    );
  });

  it("rejects duplicate runbook ids", () => {
    const registry = new RunbookRegistry();
    registry.registerAction(new FakeAction("act-1", "read-only"));
    registry.registerRunbook(runbook());
    expect(() => registry.registerRunbook(runbook())).toThrow(
      /Duplicate runbook id/
    );
  });

  it("matches on empty matcher (wildcard)", () => {
    const registry = new RunbookRegistry();
    registry.registerAction(new FakeAction("act-1", "read-only"));
    registry.registerRunbook(runbook({ matcher: {} }));

    expect(registry.findMatching(alert())).toHaveLength(1);
  });

  it("matches alertName exactly", () => {
    const registry = new RunbookRegistry();
    registry.registerAction(new FakeAction("act-1", "read-only"));
    registry.registerRunbook(
      runbook({ matcher: { alertName: "OOMKilled" } })
    );

    expect(registry.findMatching(alert())).toHaveLength(1);
    expect(
      registry.findMatching(alert({ name: "HighRequestLatency" }))
    ).toHaveLength(0);
  });

  it("enforces minSeverity ordering", () => {
    const registry = new RunbookRegistry();
    registry.registerAction(new FakeAction("act-1", "read-only"));
    registry.registerRunbook(
      runbook({ matcher: { minSeverity: "warning" } })
    );

    expect(registry.findMatching(alert({ severity: "critical" }))).toHaveLength(1);
    expect(registry.findMatching(alert({ severity: "warning" }))).toHaveLength(1);
    expect(registry.findMatching(alert({ severity: "info" }))).toHaveLength(0);
  });

  it("never matches unknown severity against any minSeverity", () => {
    const registry = new RunbookRegistry();
    registry.registerAction(new FakeAction("act-1", "read-only"));
    registry.registerRunbook(
      runbook({ matcher: { minSeverity: "info" } })
    );

    expect(registry.findMatching(alert({ severity: "unknown" }))).toHaveLength(0);
  });

  it("requires all matcher labels to be present and equal", () => {
    const registry = new RunbookRegistry();
    registry.registerAction(new FakeAction("act-1", "read-only"));
    registry.registerRunbook(
      runbook({ matcher: { labels: { team: "core" } } })
    );

    expect(registry.findMatching(alert())).toHaveLength(1);
    expect(
      registry.findMatching(
        alert({ labels: { alertname: "OOMKilled", team: "other" } })
      )
    ).toHaveLength(0);
  });
});