import { z } from "zod";

/**
 * Supported LLM providers. Adding a new provider requires extending
 * this enum and the provider factory in the agent layer (OCP).
 */
export const LlmProviderSchema = z.enum(["openai", "anthropic"]);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

/**
 * Execution mode for runbook actions.
 * - "dry-run": actions are planned and logged, never executed (default).
 * - "live": actions are executed after passing the approval gate.
 */
export const ExecutionModeSchema = z.enum(["dry-run", "live"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

/**
 * Log levels supported by pino.
 */
export const LogLevelSchema = z.enum([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

/**
 * Full application configuration schema.
 * Every environment variable is validated at startup; the process
 * fails fast on invalid config instead of failing later at runtime.
 */
export const ConfigSchema = z.object({
  /** LLM provider selection. */
  llmProvider: LlmProviderSchema.default("openai"),

  /** Model identifier passed to the selected provider. */
  llmModel: z.string().min(1).default("gpt-4o"),

  /** API key for the selected provider. Required, never logged. */
  llmApiKey: z.string().min(1, "LLM API key must not be empty"),

  /** HTTP server port for the Alertmanager webhook. */
  port: z.coerce.number().int().min(1).max(65535).default(3000),

  /** Execution mode. Defaults to dry-run for safety. */
  executionMode: ExecutionModeSchema.default("dry-run"),

  /** Minimum log level. */
  logLevel: LogLevelSchema.default("info"),

  /**
   * Approval request timeout in milliseconds. Unanswered approvals
   * are denied after this period (silence is denial).
   */
  approvalTimeoutMs: z.coerce
    .number()
    .int()
    .min(1000)
    .max(3_600_000)
    .default(300_000),

  /** Path to the JSONL incident history file. */
  incidentFilePath: z.string().min(1).default("data/incidents.jsonl"),
});

export type Config = z.infer<typeof ConfigSchema>;