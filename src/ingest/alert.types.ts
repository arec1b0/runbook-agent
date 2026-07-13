import { z } from "zod";

/**
 * Alert status as reported by Alertmanager.
 */
export const AlertStatusSchema = z.enum(["firing", "resolved"]);
export type AlertStatus = z.infer<typeof AlertStatusSchema>;

/**
 * Severity levels recognized by the agent. Alerts with unknown or
 * missing severity are normalized to "unknown" and never trigger
 * automated actions — only diagnostics collection is allowed for them.
 */
export const SeveritySchema = z.enum([
  "critical",
  "warning",
  "info",
  "unknown",
]);
export type Severity = z.infer<typeof SeveritySchema>;

/**
 * A single alert within an Alertmanager webhook payload.
 * Field names follow the Alertmanager v4 webhook format.
 */
export const RawAlertSchema = z.object({
  status: AlertStatusSchema,
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()).default({}),
  startsAt: z.string(),
  endsAt: z.string().optional(),
  fingerprint: z.string().optional(),
});
export type RawAlert = z.infer<typeof RawAlertSchema>;

/**
 * Top-level Alertmanager webhook payload (version "4").
 * Unknown extra fields are intentionally allowed and ignored so that
 * minor Alertmanager upgrades do not break ingestion (robustness).
 */
export const AlertmanagerWebhookSchema = z.object({
  version: z.string(),
  groupKey: z.string(),
  status: AlertStatusSchema,
  receiver: z.string(),
  alerts: z.array(RawAlertSchema).min(1),
});
export type AlertmanagerWebhook = z.infer<typeof AlertmanagerWebhookSchema>;

/**
 * Normalized internal alert representation.
 *
 * The rest of the system depends only on this type, never on the raw
 * Alertmanager format (ISP: consumers see exactly the fields they
 * need; a future ingestion source — e.g. Grafana OnCall — only has to
 * produce NormalizedAlert).
 */
export interface NormalizedAlert {
  /** Stable identifier: Alertmanager fingerprint or a derived hash. */
  readonly id: string;

  /** Alert name from the "alertname" label. */
  readonly name: string;

  /** Current status. */
  readonly status: AlertStatus;

  /** Normalized severity. */
  readonly severity: Severity;

  /** Target service name from the "service" or "job" label, if any. */
  readonly service: string | null;

  /** Kubernetes namespace from labels, if any. */
  readonly namespace: string | null;

  /** Human-readable summary from annotations, if any. */
  readonly summary: string | null;

  /** All original labels, preserved for matching and audit. */
  readonly labels: Readonly<Record<string, string>>;

  /** Alert start time as ISO string. */
  readonly startsAt: string;
}