import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockLanguageModelV1 } from "ai/test";
import { RunbookRegistry } from "../../src/runbooks/runbook.registry.js";
import { DEFAULT_RUNBOOKS } from "../../src/runbooks/default.runbooks.js";
import { RestartServiceAction } from "../../src/runbooks/actions/restart-service.action.js";
import { ScaleDeploymentAction } from "../../src/runbooks/actions/scale-deployment.action.js";
import { CollectDiagnosticsAction } from "../../src/runbooks/actions/collect-diagnostics.action.js";
import { ApprovalGate } from "../../src/safety/approval.gate.js";
import { ExecutionEngine } from "../../src/safety/execution.engine.js";
import { TriageAgent } from "../../src/agent/agent.js";
import { IncidentStore } from "../../src/agent/memory/incident.store.js";
import { AlertPipeline } from "../../src/pipeline/alert.pipeline.js";
import { createMetrics, METRICS } from "../../src/observability/metrics.js";
import { parseAlertmanagerWebhook } from "../../src/ingest/alertmanager.webhook.js";
import type { NormalizedAlert } from "../../src/ingest/alert.types.js";
import { FakeRunner, testLogger } from "../helpers/fakes.js";

/**
 * Builds a mock LLM that always returns the given triage decision.
 * MockLanguageModelV1 exercises the real generateObject parsing and
 * schema validation path — only the token generation is faked.
 */
function mockModel(decision: {
  apply: boolean;
  runbookId: string | null;
  reasoning: string;
}): MockLanguageModelV1 {
  return new MockLanguageModelV1({
    defaultObjectGenerationMode: "json",
    doGenerate: async () => ({
      text: JSON.stringify(decision),
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 10 },
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  });
}

/**
 * Realistic Alertmanager v4 webhook payload for an OOM alert.
 */
function oomWebhookPayload(): unknown {
  return {
    version: "4",
    groupKey: '{}:{alertname="OOMKilled"}',
    status: "firing",
    receiver: "runbook-agent",
    alerts: [
      {
        status: "firing",
        labels: {
          alertname: "OOMKilled",
          severity: "critical",
          service: "checkout-api",
          namespace: "prod",
        },
        annotations: {
          summary: "Container killed by OOM in checkout-api",
        },
        startsAt: "2026-07-13T10:00:00Z",
        fingerprint: "deadbeef01",
      },
    ],
  };
}

interface Harness {
  readonly pipeline: AlertPipeline;
  readonly metrics: ReturnType<typeof createMetrics>;
  readonly incidentFile: string;
}

/**
 * Wires a full pipeline in dry-run mode with the given mock model.
 */
async function buildHarness(
  model: MockLanguageModelV1,
  incidentFile: string
): Promise<Harness> {
  const logger = testLogger();
  const metrics = createMetrics();
  const runner = new FakeRunner();

  const registry = new RunbookRegistry();
  registry.registerAction(new CollectDiagnosticsAction(runner));
  registry.registerAction(new RestartServiceAction(runner));
  registry.registerAction(new ScaleDeploymentAction(runner));
  for (const runbook of DEFAULT_RUNBOOKS) {
    registry.registerRunbook(runbook);
  }

  const gate = new ApprovalGate("dry-run", 1000);
  const engine = new ExecutionEngine(registry, gate, metrics, true);
  const agent = new TriageAgent(model);
  const store = new IncidentStore(incidentFile, logger);
  await store.load();

  const pipeline = new AlertPipeline(
    registry,
    agent,
    engine,
    store,
    metrics,
    logger
  );

  return { pipeline, metrics, incidentFile };
}

/**
 * Parses the webhook payload and returns its single normalized alert.
 */
function singleAlert(): NormalizedAlert {
  const parsed = parseAlertmanagerWebhook(oomWebhookPayload());
  if (!parsed.ok || parsed.alerts.length !== 1) {
    throw new Error("Test payload must parse to exactly one alert");
  }
  const alert = parsed.alerts[0];
  if (!alert) {
    throw new Error("Missing alert");
  }
  return alert;
}

describe("alert-to-action pipeline (dry-run)", () => {
  let workDir: string;
  let incidentFile: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "runbook-agent-test-"));
    incidentFile = join(workDir, "incidents.jsonl");
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("remediates an OOM alert end to end", async () => {
    const model = mockModel({
      apply: true,
      runbookId: "oom-restart",
      reasoning: "OOM alert matches the oom-restart runbook.",
    });
    const harness = await buildHarness(model, incidentFile);

    const record = await harness.pipeline.handle(singleAlert());

    expect(record.status).toBe("remediated");
    expect(record.runbookId).toBe("oom-restart");
    expect(record.rolledBack).toBe(false);
    expect(record.steps.map((step) => step.actionId)).toEqual([
      "collect-diagnostics",
      "restart-service",
    ]);
    expect(record.steps.every((step) => step.status === "executed")).toBe(
      true
    );
    // Dry-run: every result is simulated, nothing touched the runner.
    expect(
      record.steps.every(
        (step) => step.result?.output["simulated"] === true
      )
    ).toBe(true);
  });

  it("persists the incident as one JSONL line", async () => {
    const model = mockModel({
      apply: true,
      runbookId: "oom-restart",
      reasoning: "Remediate.",
    });
    const harness = await buildHarness(model, incidentFile);

    await harness.pipeline.handle(singleAlert());

    const raw = await readFile(incidentFile, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(1);

    const stored = JSON.parse(lines[0] ?? "") as { status: string };
    expect(stored.status).toBe("remediated");
  });

  it("records no-runbook when the model declines", async () => {
    const model = mockModel({
      apply: false,
      runbookId: null,
      reasoning: "Root cause unclear; escalate to a human.",
    });
    const harness = await buildHarness(model, incidentFile);

    const record = await harness.pipeline.handle(singleAlert());

    expect(record.status).toBe("no-runbook");
    expect(record.steps).toHaveLength(0);
  });

  it("declines when the model invents a runbook id", async () => {
    const model = mockModel({
      apply: true,
      runbookId: "delete-namespace",
      reasoning: "Fabricated runbook.",
    });
    const harness = await buildHarness(model, incidentFile);

    const record = await harness.pipeline.handle(singleAlert());

    expect(record.status).toBe("no-runbook");
    expect(record.runbookId).toBeNull();
    expect(record.steps).toHaveLength(0);
  });

  it("never remediates a resolved alert", async () => {
    const model = mockModel({
      apply: true,
      runbookId: "oom-restart",
      reasoning: "Should never be consulted.",
    });
    const harness = await buildHarness(model, incidentFile);

    const resolved: NormalizedAlert = {
      ...singleAlert(),
      status: "resolved",
    };
    const record = await harness.pipeline.handle(resolved);

    expect(record.status).toBe("no-runbook");
    expect(record.steps).toHaveLength(0);
  });

  it("counts pipeline metrics", async () => {
    const model = mockModel({
      apply: true,
      runbookId: "oom-restart",
      reasoning: "Remediate.",
    });
    const harness = await buildHarness(model, incidentFile);

    await harness.pipeline.handle(singleAlert());

    const rendered = harness.metrics.render();
    expect(rendered).toContain(`${METRICS.ALERTS_RECEIVED} 1`);
    expect(rendered).toContain(`${METRICS.ACTIONS_EXECUTED} 2`);
    expect(rendered).toContain(`${METRICS.ACTIONS_ROLLED_BACK} 0`);
  });

  it("uses incident history in the triage prompt on repeat alerts", async () => {
    let capturedPrompt = "";
    const model = new MockLanguageModelV1({
      defaultObjectGenerationMode: "json",
      doGenerate: async (options) => {
        capturedPrompt = JSON.stringify(options.prompt);
        return {
          text: JSON.stringify({
            apply: false,
            runbookId: null,
            reasoning: "Observed history.",
          }),
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const harness = await buildHarness(model, incidentFile);

    // First run creates history; second run must see it in the prompt.
    await harness.pipeline.handle(singleAlert());
    await harness.pipeline.handle(singleAlert());

    expect(capturedPrompt).toContain("RELEVANT PAST INCIDENTS");
    expect(capturedPrompt).toContain("OOMKilled");
    expect(capturedPrompt).not.toContain("No relevant past incidents");
  });
});