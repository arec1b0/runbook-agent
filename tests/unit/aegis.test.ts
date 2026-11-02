import { MockLanguageModelV1 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  agentSpan,
  session,
  setupTracing,
  telemetry,
  toolSpan,
  traced,
} from "../../src/observability/aegis.js";

describe("tracing off (TRACEBLAME_ENABLED unset)", () => {
  it("does not start", async () => {
    expect(await setupTracing()).toBe(false);
    expect(telemetry()).toEqual({ isEnabled: false });
  });

  it("runs every helper's function unchanged", async () => {
    const model = new MockLanguageModelV1();
    expect(traced(model)).toBe(model);
    const failures: string[] = [];
    const result = await session("alert-1", () =>
      agentSpan("runbook-agent", () =>
        toolSpan("restart-service", { deployment: "d" }, (tool) => {
          tool.fail("rejected");
          failures.push("called");
          return Promise.resolve(42);
        })
      )
    );
    expect(result).toBe(42);
    expect(failures).toEqual(["called"]);
  });
});
