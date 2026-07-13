import { describe, expect, it } from "vitest";
import { RollbackManager } from "../../src/safety/rollback.manager.js";
import type { RunbookAction } from "../../src/runbooks/action.interface.js";
import { FakeAction, testLogger, testTrace } from "../helpers/fakes.js";

const INPUT = { deployment: "api", namespace: "prod" };

describe("RollbackManager", () => {
  it("rolls back recorded actions in LIFO order", async () => {
    const manager = new RollbackManager();
    const order: string[] = [];

    const first = new FakeAction("first", "reversible");
    const second = new FakeAction("second", "reversible");
    first.rollback = async (input, _ctx) => {
      order.push("first");
      first.rollbackCalls.push(input);
      return { success: true, message: "", output: {}, durationSeconds: 0 };
    };
    second.rollback = async (input, _ctx) => {
      order.push("second");
      second.rollbackCalls.push(input);
      return { success: true, message: "", output: {}, durationSeconds: 0 };
    };

    manager.record(first as RunbookAction<unknown>, INPUT);
    manager.record(second as RunbookAction<unknown>, INPUT);

    const results = await manager.rollbackAll(testLogger(), testTrace(), false);

    expect(order).toEqual(["second", "first"]);
    expect(results).toHaveLength(2);
    expect(manager.depth).toBe(0);
  });

  it("continues past a failed rollback step", async () => {
    const manager = new RollbackManager();

    const first = new FakeAction("first", "reversible");
    const second = new FakeAction("second", "reversible");
    second.rollbackSucceeds = false;

    manager.record(first as RunbookAction<unknown>, INPUT);
    manager.record(second as RunbookAction<unknown>, INPUT);

    const results = await manager.rollbackAll(testLogger(), testTrace(), false);

    expect(results).toHaveLength(2);
    expect(results[0]?.success).toBe(false);
    expect(results[1]?.success).toBe(true);
    expect(first.rollbackCalls).toHaveLength(1);
  });

  it("never records actions without a rollback method", async () => {
    const manager = new RollbackManager();
    const irreversible = new FakeAction("restart", "disruptive", "d", false);

    manager.record(irreversible as RunbookAction<unknown>, INPUT);

    expect(manager.depth).toBe(0);
    const results = await manager.rollbackAll(testLogger(), testTrace(), false);
    expect(results).toHaveLength(0);
  });

  it("passes the original input to rollback", async () => {
    const manager = new RollbackManager();
    const action = new FakeAction("scale", "reversible");

    manager.record(action as RunbookAction<unknown>, INPUT);
    await manager.rollbackAll(testLogger(), testTrace(), false);

    expect(action.rollbackCalls[0]).toEqual(INPUT);
  });
});