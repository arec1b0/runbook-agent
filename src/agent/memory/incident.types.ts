import type { NormalizedAlert } from "../../ingest/alert.types.js";
import type { StepOutcome } from "../../safety/execution.engine.js";

/**
 * Final status of a handled incident.
 */
export type IncidentStatus =
  | "remediated"
  | "diagnostics-only"
  | "failed"
  | "rejected"
  | "no-runbook";

/**
 * A recorded incident: one alert pipeline run and its outcome.
 * This is the unit of agent memory — past incidents inform future
 * triage decisions and provide the dataset for reliability metrics
 * (recovery duration, rollback rate, human intervention rate).
 */
export interface IncidentRecord {
  /** Pipeline trace id. */
  readonly traceId: string;

  /** The alert that triggered this incident. */
  readonly alert: NormalizedAlert;

  /** Runbook id that was applied, or null when none matched/was chosen. */
  readonly runbookId: string | null;

  /** Agent's stated reasoning for its triage decision. */
  readonly reasoning: string;

  /** Per-step outcomes. */
  readonly steps: readonly StepOutcome[];

  /** Whether any rollback was triggered. */
  readonly rolledBack: boolean;

  /** Final status. */
  readonly status: IncidentStatus;

  /** ISO timestamp when handling started. */
  readonly startedAt: string;

  /** ISO timestamp when handling finished. */
  readonly finishedAt: string;

  /** Total handling duration in seconds. */
  readonly durationSeconds: number;
}

/**
 * Compact incident summary passed to the LLM as historical context.
 * Deliberately excludes raw diagnostics output to keep prompts small
 * and free of potentially sensitive log content.
 */
export interface IncidentSummary {
  readonly alertName: string;
  readonly severity: string;
  readonly service: string | null;
  readonly runbookId: string | null;
  readonly status: IncidentStatus;
  readonly rolledBack: boolean;
  readonly durationSeconds: number;
  readonly finishedAt: string;
}