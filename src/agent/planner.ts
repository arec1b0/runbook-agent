import type { NormalizedAlert } from "../ingest/alert.types.js";
import type { Runbook } from "../runbooks/runbook.types.js";
import type { PlannedStep } from "../safety/execution.engine.js";

/**
 * Builds concrete planned steps from a runbook and an alert.
 *
 * Deterministic by design: the LLM decides WHICH runbook applies;
 * this planner decides WITH WHAT parameters — derived mechanically
 * from alert labels, never from LLM output. This split keeps the
 * blast radius of a bad LLM decision bounded to runbook selection.
 *
 * Parameter precedence: alert-derived values override static params,
 * because the alert identifies the actual affected target.
 *
 * @param runbook - Selected runbook.
 * @param alert - Normalized alert.
 * @returns Planned steps ready for the execution engine.
 */
export function buildPlan(
  runbook: Runbook,
  alert: NormalizedAlert
): readonly PlannedStep[] {
  const alertParams: Record<string, unknown> = {};

  if (alert.service !== null) {
    alertParams["deployment"] = alert.service;
  }
  if (alert.namespace !== null) {
    alertParams["namespace"] = alert.namespace;
  }

  return runbook.steps.map((step) => ({
    actionId: step.actionId,
    input: { ...step.params, ...alertParams },
  }));
}