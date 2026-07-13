import type { NormalizedAlert } from "../../ingest/alert.types.js";
import type { Runbook } from "../../runbooks/runbook.types.js";
import type { IncidentSummary } from "../memory/incident.types.js";

/**
 * System prompt for the triage decision.
 * The agent's authority is deliberately narrow: it selects among
 * pre-approved runbooks or declines; it can never compose arbitrary
 * operations. This constraint is stated explicitly in the prompt AND
 * enforced structurally by the output schema and the registry.
 */
export const TRIAGE_SYSTEM_PROMPT = `You are an SRE triage assistant embedded in an automated runbook pipeline.

Your ONLY task: given an alert, a list of candidate runbooks, and summaries of past incidents, decide which single runbook to apply, or decline.

Rules:
1. You may only choose a runbook id from the provided candidates. Never invent runbook or action ids.
2. Prefer declining ("apply": false) over guessing. A wrong remediation is worse than escalation to a human.
3. Weigh historical evidence: if the same runbook previously failed or was rolled back for the same alert and service, decline or explain why this case differs.
4. Diagnostics-only runbooks are low-risk; prefer them when the root cause is unclear.
5. Keep reasoning to 2-4 sentences, factual, no speculation about causes you cannot observe.`;

/**
 * Builds the user prompt for one triage decision.
 *
 * @param alert - Normalized alert being triaged.
 * @param candidates - Runbooks whose matchers accepted the alert.
 * @param history - Relevant past incident summaries.
 * @returns Prompt text.
 */
export function buildTriagePrompt(
  alert: NormalizedAlert,
  candidates: readonly Runbook[],
  history: readonly IncidentSummary[]
): string {
  const alertBlock = JSON.stringify(
    {
      name: alert.name,
      severity: alert.severity,
      status: alert.status,
      service: alert.service,
      namespace: alert.namespace,
      summary: alert.summary,
      labels: alert.labels,
    },
    null,
    2
  );

  const candidatesBlock = candidates
    .map(
      (runbook) =>
        `- id: ${runbook.id}\n  description: ${runbook.description}\n  steps: ${runbook.steps
          .map((step) => step.actionId)
          .join(" -> ")}`
    )
    .join("\n");

  const historyBlock =
    history.length === 0
      ? "No relevant past incidents."
      : history
          .map(
            (item) =>
              `- ${item.finishedAt} alert=${item.alertName} service=${String(
                item.service
              )} runbook=${String(item.runbookId)} status=${item.status}` +
              ` rolledBack=${String(item.rolledBack)} duration=${item.durationSeconds.toFixed(1)}s`
          )
          .join("\n");

  return `ALERT:\n${alertBlock}\n\nCANDIDATE RUNBOOKS:\n${candidatesBlock}\n\nRELEVANT PAST INCIDENTS:\n${historyBlock}\n\nDecide now.`;
}