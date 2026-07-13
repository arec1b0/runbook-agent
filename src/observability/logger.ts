import { pino, type Logger } from "pino";
import type { LogLevel } from "../config/schema.js";

/**
 * Creates the application logger.
 *
 * Redaction is mandatory: API keys and authorization headers must never
 * reach log output, regardless of what objects are passed to the logger.
 * Structured JSON output makes logs machine-parseable for the incident
 * store and for external log aggregation.
 *
 * @param level - Minimum log level from validated config.
 * @returns Configured pino logger instance.
 */
export function createLogger(level: LogLevel): Logger {
  return pino({
    level,
    redact: {
      paths: [
        "llmApiKey",
        "*.llmApiKey",
        "apiKey",
        "*.apiKey",
        "authorization",
        "*.authorization",
        "headers.authorization",
        "req.headers.authorization",
      ],
      censor: "[REDACTED]",
    },
    base: {
      service: "runbook-agent",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type { Logger };