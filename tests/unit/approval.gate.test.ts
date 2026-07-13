import { describe, expect, it, vi } from "vitest";
import { ApprovalGate } from "../../src/safety/approval.gate.js";

describe("ApprovalGate", () => {
  it("auto-approves everything in dry-run mode", () => {
    const gate = new ApprovalGate("dry-run", 1000);

    expect(gate.evaluate("read-only").kind).toBe("auto-approved");
    expect(gate.evaluate("reversible").kind).toBe("auto-approved");
    expect(gate.evaluate("disruptive").kind).toBe("auto-approved");
  });

  it("auto-approves only read-only actions in live mode", () => {
    const gate = new ApprovalGate("live", 1000);

    expect(gate.evaluate("read-only").kind).toBe("auto-approved");
    expect(gate.evaluate("reversible").kind).toBe("requires-approval");
    expect(gate.evaluate("disruptive").kind).toBe("requires-approval");
  });

  it("resolves approval when a human approves", async () => {
    const gate = new ApprovalGate("live", 60_000);

    const pendingPromise = gate.requestApproval(
      "restart-service",
      { deployment: "api" },
      "disruptive",
      "trace-1"
    );

    const pending = gate.listPending();
    expect(pending).toHaveLength(1);
    const id = pending[0]?.id ?? "";

    expect(gate.resolveApproval(id, true)).toBe(true);
    await expect(pendingPromise).resolves.toBe(true);
    expect(gate.listPending()).toHaveLength(0);
  });

  it("resolves rejection when a human rejects", async () => {
    const gate = new ApprovalGate("live", 60_000);

    const pendingPromise = gate.requestApproval(
      "scale-deployment",
      { replicas: 5 },
      "reversible",
      "trace-2"
    );

    const id = gate.listPending()[0]?.id ?? "";
    expect(gate.resolveApproval(id, false)).toBe(true);
    await expect(pendingPromise).resolves.toBe(false);
  });

  it("denies on timeout: silence is denial", async () => {
    vi.useFakeTimers();
    try {
      const gate = new ApprovalGate("live", 5000);

      const pendingPromise = gate.requestApproval(
        "restart-service",
        {},
        "disruptive",
        "trace-3"
      );

      vi.advanceTimersByTime(5001);

      await expect(pendingPromise).resolves.toBe(false);
      expect(gate.listPending()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns false when resolving a non-existent approval", () => {
    const gate = new ApprovalGate("live", 1000);
    expect(gate.resolveApproval("apr-000042", true)).toBe(false);
  });
});