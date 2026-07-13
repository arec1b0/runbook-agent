import { describe, expect, it } from "vitest";
import { buildPlan } from "../../src/agent/planner.js";
import type { Runbook } from "../../src/runbooks/runbook.types.js";
import type { NormalizedAlert } from "../../src/ingest/alert.types.js";

const RUNBOOK: Runbook = {
  id: "rb",
  description: "test",
  matcher: {},
  steps: [
    { actionId: "collect-diagnostics", params: {} },
    { actionId: "scale-deployment", params: { replicas: 5 } },
  ],
};

function alert(overrides: Partial<NormalizedAlert> = {}): NormalizedAlert {
  return {
    id: "a1",
    name: "HighRequestLatency",
    status: "firing",
    severity: "critical",
    service: "api",
    namespace: "prod",
    summary: null,
    labels: {},
    startsAt: "2026-07-13T10:00:00Z",
    ...overrides,
  };
}

describe("buildPlan", () => {
  it("derives deployment and namespace from the alert", () => {
    const plan = buildPlan(RUNBOOK, alert());

    expect(plan).toHaveLength(2);
    expect(plan[0]?.input).toEqual({
      deployment: "api",
      namespace: "prod",
    });
    expect(plan[1]?.input).toEqual({
      deployment: "api",
      namespace: "prod",
      replicas: 5,
    });
  });

  it("lets alert-derived values override static params", () => {
    const runbook: Runbook = {
      ...RUNBOOK,
      steps: [
        {
          actionId: "scale-deployment",
          params: { deployment: "hardcoded", replicas: 3 },
        },
      ],
    };

    const plan = buildPlan(runbook, alert());

    expect(plan[0]?.input).toEqual({
      deployment: "api",
      namespace: "prod",
      replicas: 3,
    });
  });

  it("omits absent alert fields instead of injecting null", () => {
    const plan = buildPlan(RUNBOOK, alert({ service: null, namespace: null }));

    expect(plan[0]?.input).toEqual({});
    expect(plan[1]?.input).toEqual({ replicas: 5 });
  });

  it("preserves step order", () => {
    const plan = buildPlan(RUNBOOK, alert());

    expect(plan.map((step) => step.actionId)).toEqual([
      "collect-diagnostics",
      "scale-deployment",
    ]);
  });
});