import { z } from "zod";
import type {
  ActionContext,
  ActionResult,
  RunbookAction,
} from "../action.interface.js";
import type { CommandRunner } from "./command.runner.js";

const COMMAND_TIMEOUT_MS = 30_000;

/**
 * Input for the restart-service action.
 */
export const RestartServiceInputSchema = z.object({
  /** Kubernetes deployment name. */
  deployment: z.string().min(1),

  /** Kubernetes namespace. */
  namespace: z.string().min(1),
});
export type RestartServiceInput = z.infer<typeof RestartServiceInputSchema>;

/**
 * Restarts a Kubernetes deployment via a rolling restart.
 *
 * Risk: "disruptive" — the previous process state cannot be restored,
 * so this action always requires explicit approval in live mode.
 * Rollback is intentionally absent: a rolling restart has no inverse.
 */
export class RestartServiceAction
  implements RunbookAction<RestartServiceInput>
{
  readonly id = "restart-service";
  readonly description =
    "Performs a rolling restart of a Kubernetes deployment";
  readonly risk = "disruptive" as const;
  readonly inputSchema = RestartServiceInputSchema;

  constructor(private readonly runner: CommandRunner) {}

  async execute(
    input: RestartServiceInput,
    ctx: ActionContext
  ): Promise<ActionResult> {
    const started = performance.now();
    const args = [
      "rollout",
      "restart",
      `deployment/${input.deployment}`,
      "-n",
      input.namespace,
    ];

    if (ctx.dryRun) {
      ctx.logger.info(
        { trace: ctx.trace, action: this.id, args, dryRun: true },
        "Dry-run: would execute kubectl rollout restart"
      );
      return {
        success: true,
        message: `[dry-run] kubectl ${args.join(" ")}`,
        output: { simulated: true },
        durationSeconds: elapsed(started),
      };
    }

    const result = await this.runner.run("kubectl", args, COMMAND_TIMEOUT_MS);

    if (result.exitCode !== 0) {
      ctx.logger.error(
        { trace: ctx.trace, action: this.id, result },
        "Rolling restart failed"
      );
      return {
        success: false,
        message: `kubectl exited with code ${result.exitCode}: ${result.stderr}`,
        output: { stderr: result.stderr },
        durationSeconds: elapsed(started),
      };
    }

    ctx.logger.info(
      { trace: ctx.trace, action: this.id, deployment: input.deployment },
      "Rolling restart initiated"
    );
    return {
      success: true,
      message: `Rolling restart initiated for ${input.namespace}/${input.deployment}`,
      output: { stdout: result.stdout },
      durationSeconds: elapsed(started),
    };
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