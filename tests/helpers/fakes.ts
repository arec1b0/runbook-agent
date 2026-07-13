import { pino, type Logger } from "pino";
import { z } from "zod";
import type {
  ActionContext,
  ActionResult,
  ActionRisk,
  RunbookAction,
} from "../../src/runbooks/action.interface.js";
import type {
  CommandResult,
  CommandRunner,
} from "../../src/runbooks/actions/command.runner.js";
import type { TraceContext } from "../../src/observability/trace.js";

/**
 * Silent logger for tests.
 */
export function testLogger(): Logger {
  return pino({ level: "silent" });
}

/**
 * Fresh trace context for tests.
 */
export function testTrace(): TraceContext {
  return { traceId: "test-trace", step: 0 };
}

/**
 * Input schema shared by fake actions.
 */
export const FakeInputSchema = z.object({
  deployment: z.string().min(1),
  namespace: z.string().min(1),
});
export type FakeInput = z.infer<typeof FakeInputSchema>;

/**
 * Configurable fake action recording every execute/rollback call.
 */
export class FakeAction implements RunbookAction<FakeInput> {
  readonly inputSchema = FakeInputSchema;
  readonly executeCalls: FakeInput[] = [];
  readonly rollbackCalls: FakeInput[] = [];

  executeSucceeds = true;
  rollbackSucceeds = true;

  constructor(
    readonly id: string,
    readonly risk: ActionRisk,
    readonly description = `fake action ${id}`,
    private readonly supportsRollback = true
  ) {
    if (!supportsRollback) {
      // Remove rollback to model actions without one (e.g. restart).
      this.rollback = undefined;
    }
  }

  async execute(
    input: FakeInput,
    _ctx: ActionContext
  ): Promise<ActionResult> {
    this.executeCalls.push(input);
    return {
      success: this.executeSucceeds,
      message: this.executeSucceeds ? "ok" : "boom",
      output: {},
      durationSeconds: 0.01,
    };
  }

  rollback?: (
    input: FakeInput,
    ctx: ActionContext
  ) => Promise<ActionResult> = async (input, _ctx) => {
    this.rollbackCalls.push(input);
    return {
      success: this.rollbackSucceeds,
      message: this.rollbackSucceeds ? "rolled back" : "rollback boom",
      output: {},
      durationSeconds: 0.01,
    };
  };
}

/**
 * Fake command runner returning scripted results per command prefix.
 */
export class FakeRunner implements CommandRunner {
  readonly calls: { command: string; args: readonly string[] }[] = [];
  private readonly responses: CommandResult[] = [];

  /**
   * Queues the next response (FIFO).
   */
  enqueue(result: CommandResult): void {
    this.responses.push(result);
  }

  async run(
    command: string,
    args: readonly string[],
    _timeoutMs: number
  ): Promise<CommandResult> {
    this.calls.push({ command, args });
    return (
      this.responses.shift() ?? { exitCode: 0, stdout: "", stderr: "" }
    );
  }
}