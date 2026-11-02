import type {
  ActionContext,
  ActionResult,
} from "../runbooks/action.interface.js";
import type { RunbookRegistry } from "../runbooks/runbook.registry.js";
import type { Logger } from "../observability/logger.js";
import {
  METRICS,
  type MetricsRegistry,
} from "../observability/metrics.js";
import { nextStep, type TraceContext } from "../observability/trace.js";
import type { ApprovalGate } from "./approval.gate.js";
import { RollbackManager } from "./rollback.manager.js";
import { toolSpan } from "../observability/aegis.js";

/**
 * A planned step: action id plus raw (not yet validated) input.
 */
export interface PlannedStep {
  readonly actionId: string;
  readonly input: unknown;
}

/**
 * Outcome of executing a plan.
 */
export interface PlanExecutionResult {
  /** True when every step succeeded. */
  readonly success: boolean;

  /** Per-step results in execution order. */
  readonly steps: readonly StepOutcome[];

  /** Rollback results, non-empty only when a rollback was triggered. */
  readonly rollbacks: readonly ActionResult[];
}

/**
 * Result of a single step attempt.
 */
export interface StepOutcome {
  readonly actionId: string;
  readonly status:
    | "executed"
    | "failed"
    | "rejected"
    | "invalid-input"
    | "unknown-action";
  readonly result: ActionResult | null;
  readonly detail: string;
}

/**
 * Executes a validated plan step by step with the full safety chain:
 * input validation -> approval gate -> execution -> rollback on failure.
 *
 * Failure semantics: the first failed or rejected step stops the plan
 * and triggers rollback of all previously executed reversible steps
 * (all-or-nothing within one plan, best-effort rollback).
 */
export class ExecutionEngine {
  constructor(
    private readonly registry: RunbookRegistry,
    private readonly gate: ApprovalGate,
    private readonly metrics: MetricsRegistry,
    private readonly dryRun: boolean
  ) {}

  /**
   * Executes a plan for one alert pipeline run.
   *
   * @param steps - Planned steps in execution order.
   * @param logger - Pipeline logger.
   * @param trace - Pipeline trace context.
   * @returns Aggregated execution result.
   */
  async executePlan(
    steps: readonly PlannedStep[],
    logger: Logger,
    trace: TraceContext
  ): Promise<PlanExecutionResult> {
    const rollbackManager = new RollbackManager();
    const outcomes: StepOutcome[] = [];
    let currentTrace = trace;

    for (const step of steps) {
      currentTrace = nextStep(currentTrace);
      const outcome = await this.executeStep(
        step,
        logger,
        currentTrace,
        rollbackManager
      );
      outcomes.push(outcome);

      if (outcome.status !== "executed") {
        const rollbacks = await rollbackManager.rollbackAll(
          logger,
          currentTrace,
          this.dryRun
        );
        if (rollbacks.length > 0) {
          this.metrics.incrementCounter(
            METRICS.ACTIONS_ROLLED_BACK,
            rollbacks.length
          );
        }
        return { success: false, steps: outcomes, rollbacks };
      }
    }

    return { success: true, steps: outcomes, rollbacks: [] };
  }

  /**
   * Executes a single step through the safety chain.
   *
   * @param step - Planned step.
   * @param logger - Pipeline logger.
   * @param trace - Step trace context.
   * @param rollbackManager - Rollback tracker for this plan run.
   * @returns Step outcome.
   */
  private executeStep(
    step: PlannedStep,
    logger: Logger,
    trace: TraceContext,
    rollbackManager: RollbackManager
  ): Promise<StepOutcome> {
    // The whole step is one tool span: validation, the approval wait, execution.
    return toolSpan(step.actionId, step.input, async (tool) => {
      const outcome = await this.runStep(step, logger, trace, rollbackManager);
      if (outcome.status !== "executed") {
        tool.fail(outcome.status);
      }
      return outcome;
    });
  }

  /** The safety chain of one step, inside executeStep's span. */
  private async runStep(
    step: PlannedStep,
    logger: Logger,
    trace: TraceContext,
    rollbackManager: RollbackManager
  ): Promise<StepOutcome> {
    const action = this.registry.getAction(step.actionId);
    if (!action) {
      return {
        actionId: step.actionId,
        status: "unknown-action",
        result: null,
        detail: `Action "${step.actionId}" is not registered`,
      };
    }

    const parsed = action.inputSchema.safeParse(step.input);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      return {
        actionId: step.actionId,
        status: "invalid-input",
        result: null,
        detail: `Input validation failed: ${detail}`,
      };
    }

    this.metrics.incrementCounter(METRICS.ACTIONS_PROPOSED);

    const decision = this.gate.evaluate(action.risk);
    if (decision.kind === "denied") {
      this.metrics.incrementCounter(METRICS.ACTIONS_REJECTED);
      return {
        actionId: step.actionId,
        status: "rejected",
        result: null,
        detail: decision.reason,
      };
    }

    if (decision.kind === "requires-approval") {
      logger.info(
        { trace, action: action.id, risk: action.risk },
        "Awaiting human approval"
      );
      const approved = await this.gate.requestApproval(
        action.id,
        step.input as Readonly<Record<string, unknown>>,
        action.risk,
        trace.traceId
      );
      if (!approved) {
        this.metrics.incrementCounter(METRICS.ACTIONS_REJECTED);
        return {
          actionId: step.actionId,
          status: "rejected",
          result: null,
          detail: "Approval rejected or timed out",
        };
      }
    }

    const ctx: ActionContext = { logger, trace, dryRun: this.dryRun };
    const result = await action.execute(parsed.data, ctx);

    this.metrics.observe(
      METRICS.ACTION_DURATION_SECONDS,
      result.durationSeconds
    );

    if (!result.success) {
      return {
        actionId: step.actionId,
        status: "failed",
        result,
        detail: result.message,
      };
    }

    this.metrics.incrementCounter(METRICS.ACTIONS_EXECUTED);
    rollbackManager.record(action, parsed.data);

    return {
      actionId: step.actionId,
      status: "executed",
      result,
      detail: result.message,
    };
  }
}