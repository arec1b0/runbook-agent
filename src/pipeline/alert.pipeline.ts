import type { NormalizedAlert } from "../ingest/alert.types.js";
import type { RunbookRegistry } from "../runbooks/runbook.registry.js";
import type {
  ExecutionEngine,
  StepOutcome,
} from "../safety/execution.engine.js";
import type { TriageAgent } from "../agent/agent.js";
import type { IncidentStore } from "../agent/memory/incident.store.js";
import type {
  IncidentRecord,
  IncidentStatus,
} from "../agent/memory/incident.types.js";
import { buildPlan } from "../agent/planner.js";
import type { Logger } from "../observability/logger.js";
import {
  METRICS,
  type MetricsRegistry,
} from "../observability/metrics.js";
import { createTrace } from "../observability/trace.js";

const HISTORY_LIMIT = 10;

/**
 * Orchestrates the full handling of one alert:
 * match runbooks -> triage (LLM) -> build plan -> execute -> record.
 *
 * The pipeline never throws: every failure mode is converted into an
 * IncidentRecord with an explicit status, because an incident handler
 * that itself crashes during an incident is the worst possible outcome.
 */
export class AlertPipeline {
  constructor(
    private readonly registry: RunbookRegistry,
    private readonly agent: TriageAgent,
    private readonly engine: ExecutionEngine,
    private readonly store: IncidentStore,
    private readonly metrics: MetricsRegistry,
    private readonly logger: Logger
  ) {}

  /**
   * Handles a single normalized alert end to end.
   *
   * Resolved alerts are recorded but never remediated: acting on an
   * alert that has already cleared can only cause harm.
   *
   * @param alert - Normalized alert from the ingest layer.
   * @returns The recorded incident.
   */
  async handle(alert: NormalizedAlert): Promise<IncidentRecord> {
    const trace = createTrace();
    const logger = this.logger.child({ traceId: trace.traceId });
    const startedAt = new Date().toISOString();
    const startedMs = performance.now();

    this.metrics.incrementCounter(METRICS.ALERTS_RECEIVED);
    logger.info(
      { alert: { name: alert.name, severity: alert.severity, status: alert.status } },
      "Alert received"
    );

    if (alert.status === "resolved") {
      return this.finish(
        alert, trace.traceId, null,
        "Alert already resolved; no action taken.",
        [], false, "no-runbook", startedAt, startedMs, logger
      );
    }

    const candidates = this.registry.findMatching(alert);
    const history = this.store.findRelevant(
      alert.name,
      alert.service,
      HISTORY_LIMIT
    );

    const decision = await this.agent.triage(
      alert, candidates, history, logger, trace
    );

    if (!decision.apply || decision.runbookId === null) {
      return this.finish(
        alert, trace.traceId, null, decision.reasoning,
        [], false, "no-runbook", startedAt, startedMs, logger
      );
    }

    const runbook = candidates.find(
      (candidate) => candidate.id === decision.runbookId
    );
    if (!runbook) {
      // Defense in depth: the agent already validates this, but the
      // pipeline must not trust upstream validation it cannot see.
      return this.finish(
        alert, trace.traceId, decision.runbookId,
        "Selected runbook not found among candidates; declined.",
        [], false, "rejected", startedAt, startedMs, logger
      );
    }

    const plan = buildPlan(runbook, alert);
    const execution = await this.engine.executePlan(plan, logger, trace);

    const status = deriveStatus(runbook, execution.success, execution.steps);
    const rolledBack = execution.rollbacks.length > 0;

    if (execution.success) {
      this.metrics.observe(
        METRICS.RECOVERY_DURATION_SECONDS,
        (performance.now() - startedMs) / 1000
      );
    }

    return this.finish(
      alert, trace.traceId, runbook.id, decision.reasoning,
      execution.steps, rolledBack, status, startedAt, startedMs, logger
    );
  }

  /**
   * Builds, persists, and returns the final incident record.
   */
  private async finish(
    alert: NormalizedAlert,
    traceId: string,
    runbookId: string | null,
    reasoning: string,
    steps: readonly StepOutcome[],
    rolledBack: boolean,
    status: IncidentStatus,
    startedAt: string,
    startedMs: number,
    logger: Logger
  ): Promise<IncidentRecord> {
    const record: IncidentRecord = {
      traceId,
      alert,
      runbookId,
      reasoning,
      steps,
      rolledBack,
      status,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationSeconds: (performance.now() - startedMs) / 1000,
    };

    await this.store.append(record);
    logger.info(
      { status, runbookId, rolledBack, durationSeconds: record.durationSeconds },
      "Incident recorded"
    );
    return record;
  }
}

/**
 * Derives the incident status from the execution outcome.
 *
 * @param runbook - Applied runbook.
 * @param success - Whether the whole plan succeeded.
 * @param steps - Per-step outcomes.
 * @returns Incident status.
 */
function deriveStatus(
  runbook: { readonly steps: readonly { readonly actionId: string }[] },
  success: boolean,
  steps: readonly StepOutcome[]
): IncidentStatus {
  if (success) {
    const onlyDiagnostics = runbook.steps.every(
      (step) => step.actionId === "collect-diagnostics"
    );
    return onlyDiagnostics ? "diagnostics-only" : "remediated";
  }
  const anyRejected = steps.some((step) => step.status === "rejected");
  return anyRejected ? "rejected" : "failed";
}