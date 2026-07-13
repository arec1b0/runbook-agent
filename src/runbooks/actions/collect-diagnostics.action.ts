import { z } from "zod";
import type {
  ActionContext,
  ActionResult,
  RunbookAction,
} from "../action.interface.js";
import type { CommandRunner } from "./command.runner.js";

const COMMAND_TIMEOUT_MS = 30_000;
const LOG_TAIL_LINES = 200;

/**
 * Input for the collect-diagnostics action.
 */
export const CollectDiagnosticsInputSchema = z.object({
  /** Kubernetes deployment name. */
  deployment: z.string().min(1),

  /** Kubernetes namespace. */
  namespace: z.string().min(1),
});
export type CollectDiagnosticsInput = z.infer<
  typeof CollectDiagnosticsInputSchema
>;

/**
 * Collects diagnostics for a deployment: pod status, recent events,
 * and log tails.
 *
 * Risk: "read-only" — no state change; eligible for auto-execution
 * even in live mode, including for alerts with unknown severity.
 */
export class CollectDiagnosticsAction
  implements RunbookAction<CollectDiagnosticsInput>
{
  readonly id = "collect-diagnostics";
  readonly description =
    "Collects pod status, events, and log tails for a deployment";
  readonly risk = "read-only" as const;
  readonly inputSchema = CollectDiagnosticsInputSchema;

  constructor(private readonly runner: CommandRunner) {}

  async execute(
    input: CollectDiagnosticsInput,
    ctx: ActionContext
  ): Promise<ActionResult> {
    const started = performance.now();

    if (ctx.dryRun) {
      ctx.logger.info(
        { trace: ctx.trace, action: this.id, input, dryRun: true },
        "Dry-run: would collect diagnostics"
      );
      return {
        success: true,
        message: `[dry-run] collect diagnostics for ${input.namespace}/${input.deployment}`,
        output: { simulated: true },
        durationSeconds: elapsed(started),
      };
    }

    const [pods, events, logs] = await Promise.all([
      this.runner.run(
        "kubectl",
        [
          "get",
          "pods",
          "-n",
          input.namespace,
          "-l",
          `app=${input.deployment}`,
          "-o",
          "wide",
        ],
        COMMAND_TIMEOUT_MS
      ),
      this.runner.run(
        "kubectl",
        [
          "get",
          "events",
          "-n",
          input.namespace,
          "--sort-by=.lastTimestamp",
        ],
        COMMAND_TIMEOUT_MS
      ),
      this.runner.run(
        "kubectl",
        [
          "logs",
          `deployment/${input.deployment}`,
          "-n",
          input.namespace,
          `--tail=${LOG_TAIL_LINES}`,
          "--all-containers=true",
        ],
        COMMAND_TIMEOUT_MS
      ),
    ]);

    const anyFailure =
      pods.exitCode !== 0 && events.exitCode !== 0 && logs.exitCode !== 0;

    ctx.logger.info(
      { trace: ctx.trace, action: this.id, deployment: input.deployment },
      "Diagnostics collected"
    );

    return {
      success: !anyFailure,
      message: anyFailure
        ? "All diagnostic commands failed; check cluster connectivity"
        : `Diagnostics collected for ${input.namespace}/${input.deployment}`,
      output: {
        pods: pods.exitCode === 0 ? pods.stdout : `ERROR: ${pods.stderr}`,
        events:
          events.exitCode === 0 ? events.stdout : `ERROR: ${events.stderr}`,
        logs: logs.exitCode === 0 ? logs.stdout : `ERROR: ${logs.stderr}`,
      },
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