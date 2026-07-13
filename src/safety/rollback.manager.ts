import type {
  ActionContext,
  ActionResult,
  RunbookAction,
} from "../runbooks/action.interface.js";
import type { Logger } from "../observability/logger.js";
import type { TraceContext } from "../observability/trace.js";

/**
 * A completed reversible execution that can be undone.
 */
interface RollbackEntry {
  readonly action: RunbookAction<unknown>;
  readonly input: unknown;
  readonly executedAt: string;
}

/**
 * Tracks executed reversible actions within one pipeline run and
 * rolls them back in reverse order (LIFO) on demand.
 *
 * Scope: one RollbackManager instance per alert pipeline run.
 * It is not shared across alerts — each incident has its own undo
 * history, mirroring how a database transaction owns its own log.
 */
export class RollbackManager {
  private readonly stack: RollbackEntry[] = [];

  /**
   * Records a successfully executed action that supports rollback.
   * Actions without a rollback method are never recorded.
   *
   * @param action - Executed action.
   * @param input - The exact input used for execution.
   */
  record(action: RunbookAction<unknown>, input: unknown): void {
    if (typeof action.rollback !== "function") {
      return;
    }
    this.stack.push({
      action,
      input,
      executedAt: new Date().toISOString(),
    });
  }

  /**
   * Rolls back all recorded actions in reverse order.
   * Continues through individual rollback failures: a failed rollback
   * of step N must not prevent attempting rollback of step N-1.
   *
   * @param logger - Pipeline logger.
   * @param trace - Pipeline trace context.
   * @param dryRun - Dry-run flag propagated to rollback calls.
   * @returns Results in rollback (reverse-execution) order.
   */
  async rollbackAll(
    logger: Logger,
    trace: TraceContext,
    dryRun: boolean
  ): Promise<readonly ActionResult[]> {
    const results: ActionResult[] = [];
    const ctx: ActionContext = { logger, trace, dryRun };

    while (this.stack.length > 0) {
      const entry = this.stack.pop();
      if (!entry?.action.rollback) {
        continue;
      }

      logger.warn(
        { trace, action: entry.action.id },
        "Rolling back action"
      );
      const result = await entry.action.rollback(entry.input, ctx);
      results.push(result);

      if (!result.success) {
        logger.error(
          { trace, action: entry.action.id, message: result.message },
          "Rollback step failed; continuing with remaining steps"
        );
      }
    }

    return results;
  }

  /**
   * Number of recorded reversible executions.
   *
   * @returns Stack depth.
   */
  get depth(): number {
    return this.stack.length;
  }
}