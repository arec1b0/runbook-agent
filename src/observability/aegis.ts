import { createHash } from "node:crypto";
import { wrapLanguageModel, type LanguageModelV1, type LanguageModelV1Middleware } from "ai";

/**
 * Optional TraceBlame tracing through traceblame-ts (arec1b0/traceblame, sdk/ts).
 *
 * Active only when TRACEBLAME_ENABLED=1 and the package is installed (the optional
 * dependency); otherwise every helper just runs its function. The shim records no prompt,
 * output or tool argument: tool arguments are hashed, LLM spans carry ids and counts only.
 * Export goes to OTEL_EXPORTER_OTLP_ENDPOINT; TRACEBLAME_* variables set the tenant and run.
 */

interface ToolHandle {
  fail(errorType: string): void;
}

interface TraceblameTs {
  instrument(options: { serviceName: string }): { shutdown(): Promise<void> };
  AI_SDK_TELEMETRY: { isEnabled: boolean; recordInputs: boolean; recordOutputs: boolean };
  statusMiddleware: LanguageModelV1Middleware;
  agentSpan<T>(name: string, fn: () => Promise<T>): Promise<T>;
  toolSpan<T>(name: string, args: object | undefined, fn: (tool: ToolHandle) => Promise<T>): Promise<T>;
  session<T>(sessionId: string, fn: () => T): T;
}

let shim: TraceblameTs | undefined;
let handle: { shutdown(): Promise<void> } | undefined;

/**
 * Starts tracing if enabled. Call once, before anything else is set up.
 *
 * @returns Whether tracing is on.
 */
export async function setupTracing(): Promise<boolean> {
  if (process.env["TRACEBLAME_ENABLED"] !== "1") {
    return false;
  }
  // A variable specifier: the package is optional, so the compiler must not resolve it.
  const specifier = "traceblame-ts";
  try {
    shim = (await import(specifier)) as TraceblameTs;
  } catch {
    return false;
  }
  handle = shim.instrument({ serviceName: "runbook-agent" });
  return true;
}

/** Flushes and stops tracing. */
export async function shutdownTracing(): Promise<void> {
  await handle?.shutdown();
}

/** AI SDK telemetry settings for generateObject (off when tracing is off). */
export function telemetry(): { isEnabled: boolean; recordInputs?: boolean; recordOutputs?: boolean } {
  return shim?.AI_SDK_TELEMETRY ?? { isEnabled: false };
}

/** The model, recording the HTTP status of failed calls on their spans. */
export function traced(model: LanguageModelV1): LanguageModelV1 {
  return shim ? wrapLanguageModel({ model, middleware: shim.statusMiddleware }) : model;
}

/** Runs fn inside the agent's span. */
export function agentSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return shim ? shim.agentSpan(name, fn) : fn();
}

/** Runs fn inside a tool span; its arguments are hashed, never recorded. */
export function toolSpan<T>(
  name: string,
  args: unknown,
  fn: (tool: ToolHandle) => Promise<T>
): Promise<T> {
  const hashed = typeof args === "object" && args !== null ? args : undefined;
  return shim ? shim.toolSpan(name, hashed, fn) : fn({ fail: () => undefined });
}

/** Runs fn with every span inside it in the alert's session. */
export function session<T>(alertId: string, fn: () => Promise<T>): Promise<T> {
  if (!shim) {
    return fn();
  }
  const id = `s-${createHash("sha256").update(alertId).digest("hex").slice(0, 16)}`;
  return shim.session(id, fn);
}
