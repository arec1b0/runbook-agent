import { z } from "zod";
import type {
  ActionContext,
  ActionResult,
  RunbookAction,
} from "../action.interface.js";
import type { CommandRunner } from "./command.runner.js";

const COMMAND_TIMEOUT_MS = 30_000;

/**
 * Input for the scale-deployment action.
 */
export const ScaleDeploymentInputSchema = z.object({
  /** Kubernetes deployment name. */
  deployment: z.string().min(1),

  /** Kubernetes namespace. */
  namespace: z.string().min(1),

  /** Target replica count; bounded to prevent runaway scaling. */
  replicas: z.number().int().min(0).max(50),
});
export type ScaleDeploymentInput = z.infer<typeof ScaleDeploymentInputSchema>;

/**
 * Scales a Kubernetes deployment to a target replica count.
 *
 * Risk: "reversible" — the previous replica count is captured before
 * scaling and restored by rollback. The captured value lives in the
 * instance for the duration of one execute/rollback cycle; the
 * execution engine guarantees rollback is called with the same input
 * on the same instance (see safety/rollback.manager.ts).
 */
export class ScaleDeploymentAction
  implements RunbookAction<ScaleDeploymentInput>
{
  readonly id = "scale-deployment";
  readonly description = "Scales a Kubernetes deployment to a replica count";
  readonly risk = "reversible" as const;
  readonly inputSchema = ScaleDeploymentInputSchema;

  /** Previous replica counts keyed by "namespace/deployment". */
  private readonly previousReplicas = new Map<string, number>();

  constructor(private readonly runner: CommandRunner) {}

  async execute(
    input: ScaleDeploymentInput,
    ctx: ActionContext
  ): Promise<ActionResult> {
    const started = performance.now();
    const key = `${input.namespace}/${input.deployment}`;

    if (ctx.dryRun) {
      ctx.logger.info(
        { trace: ctx.trace, action: this.id, input, dryRun: true },
        "Dry-run: would scale deployment"
      );
      return {
        success: true,
        message: `[dry-run] scale ${key} to ${input.replicas} replicas`,
        output: { simulated: true },
        durationSeconds: elapsed(started),
      };
    }

    const current = await this.readCurrentReplicas(input);
    if (current === null) {
      return {
        success: false,
        message: `Cannot read current replica count for ${key}; refusing to scale blindly`,
        output: {},
        durationSeconds: elapsed(started),
      };
    }
    this.previousReplicas.set(key, current);

    const result = await this.runner.run(
      "kubectl",
      [
        "scale",
        `deployment/${input.deployment}`,
        "-n",
        input.namespace,
        `--replicas=${input.replicas}`,
      ],
      COMMAND_TIMEOUT_MS
    );

    if (result.exitCode !== 0) {
      ctx.logger.error(
        { trace: ctx.trace, action: this.id, result },
        "Scale failed"
      );
      return {
        success: false,
        message: `kubectl exited with code ${result.exitCode}: ${result.stderr}`,
        output: { stderr: result.stderr, previousReplicas: current },
        durationSeconds: elapsed(started),
      };
    }

    ctx.logger.info(
      { trace: ctx.trace, action: this.id, from: current, to: input.replicas },
      "Deployment scaled"
    );
    return {
      success: true,
      message: `Scaled ${key} from ${current} to ${input.replicas} replicas`,
      output: { previousReplicas: current, newReplicas: input.replicas },
      durationSeconds: elapsed(started),
    };
  }

  async rollback(
    input: ScaleDeploymentInput,
    ctx: ActionContext
  ): Promise<ActionResult> {
    const started = performance.now();
    const key = `${input.namespace}/${input.deployment}`;
    const previous = this.previousReplicas.get(key);

    if (previous === undefined) {
      return {
        success: false,
        message: `No recorded previous replica count for ${key}; manual intervention required`,
        output: {},
        durationSeconds: elapsed(started),
      };
    }

    if (ctx.dryRun) {
      return {
        success: true,
        message: `[dry-run] rollback ${key} to ${previous} replicas`,
        output: { simulated: true },
        durationSeconds: elapsed(started),
      };
    }

    const result = await this.runner.run(
      "kubectl",
      [
        "scale",
        `deployment/${input.deployment}`,
        "-n",
        input.namespace,
        `--replicas=${previous}`,
      ],
      COMMAND_TIMEOUT_MS
    );

    const success = result.exitCode === 0;
    if (success) {
      this.previousReplicas.delete(key);
    }

    ctx.logger[success ? "info" : "error"](
      { trace: ctx.trace, action: this.id, restoredReplicas: previous },
      success ? "Rollback complete" : "Rollback failed"
    );

    return {
      success,
      message: success
        ? `Rolled back ${key} to ${previous} replicas`
        : `Rollback failed: ${result.stderr}`,
      output: { restoredReplicas: previous },
      durationSeconds: elapsed(started),
    };
  }

  /**
   * Reads the current replica count of a deployment.
   *
   * @param input - Deployment coordinates.
   * @returns Replica count, or null when it cannot be determined.
   */
  private async readCurrentReplicas(
    input: ScaleDeploymentInput
  ): Promise<number | null> {
    const result = await this.runner.run(
      "kubectl",
      [
        "get",
        `deployment/${input.deployment}`,
        "-n",
        input.namespace,
        "-o",
        "jsonpath={.spec.replicas}",
      ],
      COMMAND_TIMEOUT_MS
    );

    if (result.exitCode !== 0) {
      return null;
    }
    const value = Number.parseInt(result.stdout, 10);
    return Number.isNaN(value) ? null : value;
  }
}

/**
 * Computes elapsed seconds from a performance.now() start mark.
 *
 * @param started - Start timestamp in milliseconds.
 * @returns Elapsed seconds.
 */
function elapsed(started: number): number {
  return (performance.now() - started) / 1000;
}