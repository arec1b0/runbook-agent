import { randomUUID } from "node:crypto";

/**
 * Trace context propagated through the alert-to-action pipeline.
 *
 * Every alert receives a traceId at ingestion; every agent decision,
 * approval, execution, and rollback is logged with the same traceId,
 * making the full decision chain reconstructable from logs alone.
 */
export interface TraceContext {
  /** Unique identifier for one alert-handling pipeline run. */
  readonly traceId: string;

  /** Monotonic step counter within the trace. */
  readonly step: number;
}

/**
 * Creates a new trace context for an incoming alert.
 *
 * @returns Fresh trace context with step 0.
 */
export function createTrace(): TraceContext {
  return { traceId: randomUUID(), step: 0 };
}

/**
 * Advances a trace to the next step. Trace contexts are immutable;
 * each pipeline stage receives its own step number.
 *
 * @param ctx - Current trace context.
 * @returns New trace context with an incremented step.
 */
export function nextStep(ctx: TraceContext): TraceContext {
  return { traceId: ctx.traceId, step: ctx.step + 1 };
}