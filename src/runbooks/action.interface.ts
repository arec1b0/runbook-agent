import { z } from "zod";
import type { Logger } from "../observability/logger.js";
import type { TraceContext } from "../observability/trace.js";

/**
 * Risk classification for an action.
 * - "read-only": no state change (e.g. collecting diagnostics).
 * - "reversible": changes state and provides a rollback (e.g. scaling).
 * - "disruptive": changes state with best-effort rollback only
 *   (e.g. restart — the previous process state cannot be restored).
 *
 * The approval gate uses this classification: read-only actions may
 * auto-execute, everything else requires explicit approval in live mode.
 */
export type ActionRisk = "read-only" | "reversible" | "disruptive";

/**
 * Outcome of an action execution.
 */
export interface ActionResult {
  /** Whether the action completed successfully. */
  readonly success: boolean;

  /** Human-readable outcome description for logs and incident store. */
  readonly message: string;

  /** Structured output (diagnostics payloads, previous replica count, etc.). */
  readonly output: Readonly<Record<string, unknown>>;

  /** Execution duration in seconds. */
  readonly durationSeconds: number;
}

/**
 * Context passed to every action execution.
 */
export interface ActionContext {
  readonly logger: Logger;
  readonly trace: TraceContext;

  /** True when the system runs in dry-run mode: simulate, never mutate. */
  readonly dryRun: boolean;
}

/**
 * A runbook action: the single abstraction the agent layer depends on.
 *
 * Contract (LSP — every implementation MUST honor all of these):
 * 1. `execute` MUST respect `ctx.dryRun`: when true, no side effects.
 * 2. `execute` MUST NOT throw; failures are returned as ActionResult.
 * 3. If `risk` is "reversible", `rollback` MUST undo the last execute.
 * 4. `inputSchema` MUST fully validate any input before execution.
 *
 * @typeParam TInput - Validated input type for this action.
 */
export interface RunbookAction<TInput = unknown> {
  /** Unique action identifier, e.g. "restart-service". */
  readonly id: string;

  /** One-line description shown to the agent and in approval prompts. */
  readonly description: string;

  /** Risk classification driving the approval policy. */
  readonly risk: ActionRisk;

  /** Zod schema validating the action input. */
  readonly inputSchema: z.ZodType<TInput>;

  /**
   * Executes the action.
   *
   * @param input - Validated input.
   * @param ctx - Execution context (logger, trace, dry-run flag).
   * @returns Result; never throws.
   */
  execute(input: TInput, ctx: ActionContext): Promise<ActionResult>;

  /**
   * Rolls back the most recent execution, if supported.
   * Required for "reversible" actions; optional otherwise.
   *
   * @param input - The same input that was passed to execute.
   * @param ctx - Execution context.
   * @returns Rollback result; never throws.
   */
  rollback?(input: TInput, ctx: ActionContext): Promise<ActionResult>;
}