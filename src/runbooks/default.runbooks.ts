import type { Runbook } from "./runbook.types.js";

/**
 * Built-in runbooks shipped with the agent.
 *
 * Design notes:
 * - "investigate-unknown" matches ANY alert (empty matcher) and only
 *   collects diagnostics — the universal safe fallback the triage
 *   agent can always choose when the root cause is unclear.
 * - Remediation runbooks require explicit severity thresholds; they
 *   never match alerts with unknown severity (enforced by the
 *   registry's severity ranking).
 * - Deployment/namespace parameters are intentionally absent from
 *   step params: the planner fills them from alert labels, so a
 *   runbook can never target a hardcoded service by mistake.
 */
export const DEFAULT_RUNBOOKS: readonly Runbook[] = [
  {
    id: "investigate-unknown",
    description:
      "Collects diagnostics only; safe fallback for any alert whose root cause is unclear",
    matcher: {},
    steps: [{ actionId: "collect-diagnostics", params: {} }],
  },
  {
    id: "oom-restart",
    description:
      "Handles container OOM kills: collect diagnostics, then perform a rolling restart",
    matcher: {
      alertName: "OOMKilled",
      minSeverity: "warning",
    },
    steps: [
      { actionId: "collect-diagnostics", params: {} },
      { actionId: "restart-service", params: {} },
    ],
  },
  {
    id: "high-load-scale-up",
    description:
      "Handles sustained high load: collect diagnostics, then scale the deployment up",
    matcher: {
      alertName: "HighRequestLatency",
      minSeverity: "critical",
    },
    steps: [
      { actionId: "collect-diagnostics", params: {} },
      { actionId: "scale-deployment", params: { replicas: 5 } },
    ],
  },
];