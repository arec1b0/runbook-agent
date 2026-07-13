import type { Severity } from "../ingest/alert.types.js";

/**
 * A matching rule binding alerts to a runbook.
 * All specified fields must match (logical AND). Unspecified fields
 * are wildcards.
 */
export interface RunbookMatcher {
  /** Exact alert name to match, e.g. "HighMemoryUsage". */
  readonly alertName?: string;

  /** Minimum severity required (critical > warning > info). */
  readonly minSeverity?: Severity;

  /** Required label values, all of which must be present and equal. */
  readonly labels?: Readonly<Record<string, string>>;
}

/**
 * A single step within a runbook: an action id plus a template for
 * building its input from the alert.
 */
export interface RunbookStep {
  /** Action id registered in the ActionRegistry. */
  readonly actionId: string;

  /**
   * Static input parameters merged with alert-derived parameters
   * at planning time. Alert-derived values (service, namespace)
   * take precedence and are filled by the planner.
   */
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * A runbook: an ordered remediation recipe for a class of alerts.
 */
export interface Runbook {
  /** Unique runbook identifier, e.g. "oom-restart". */
  readonly id: string;

  /** Human-readable description of what this runbook remediates. */
  readonly description: string;

  /** Matching rule selecting which alerts this runbook applies to. */
  readonly matcher: RunbookMatcher;

  /** Ordered steps; executed sequentially, stop on first failure. */
  readonly steps: readonly RunbookStep[];
}