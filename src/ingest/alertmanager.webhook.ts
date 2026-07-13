import { createHash } from "node:crypto";
import {
  AlertmanagerWebhookSchema,
  SeveritySchema,
  type AlertmanagerWebhook,
  type NormalizedAlert,
  type RawAlert,
  type Severity,
} from "./alert.types.js";

/**
 * Result of parsing an incoming webhook body.
 * A discriminated union keeps error handling explicit at the call
 * site — no thrown exceptions on the ingestion hot path.
 */
export type ParseResult =
  | { readonly ok: true; readonly alerts: readonly NormalizedAlert[] }
  | { readonly ok: false; readonly error: string };

/**
 * Parses and validates a raw Alertmanager webhook body.
 *
 * @param body - Unknown JSON body from the HTTP layer.
 * @returns Normalized alerts, or a descriptive validation error.
 */
export function parseAlertmanagerWebhook(body: unknown): ParseResult {
  const parsed = AlertmanagerWebhookSchema.safeParse(body);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    return { ok: false, error: `Invalid Alertmanager payload: ${details}` };
  }

  const alerts = parsed.data.alerts.map((raw) =>
    normalizeAlert(raw, parsed.data)
  );
  return { ok: true, alerts };
}

/**
 * Normalizes a raw alert into the internal representation.
 *
 * @param raw - Single alert from the webhook payload.
 * @param envelope - Webhook envelope, used for fallback identity.
 * @returns Normalized alert.
 */
function normalizeAlert(
  raw: RawAlert,
  envelope: AlertmanagerWebhook
): NormalizedAlert {
  return {
    id: raw.fingerprint ?? deriveAlertId(raw, envelope.groupKey),
    name: raw.labels["alertname"] ?? "unnamed-alert",
    status: raw.status,
    severity: normalizeSeverity(raw.labels["severity"]),
    service: raw.labels["service"] ?? raw.labels["job"] ?? null,
    namespace: raw.labels["namespace"] ?? null,
    summary: raw.annotations["summary"] ?? null,
    labels: Object.freeze({ ...raw.labels }),
    startsAt: raw.startsAt,
  };
}

/**
 * Normalizes a severity label to a known value.
 * Unrecognized severities map to "unknown" (fail-safe: unknown alerts
 * never qualify for automated remediation).
 *
 * @param value - Raw severity label value, possibly undefined.
 * @returns Known severity.
 */
function normalizeSeverity(value: string | undefined): Severity {
  const candidate = SeveritySchema.safeParse(value?.toLowerCase());
  return candidate.success ? candidate.data : "unknown";
}

/**
 * Derives a deterministic alert id when Alertmanager did not provide
 * a fingerprint. Same labels + group => same id (idempotent ingestion).
 *
 * @param raw - Raw alert.
 * @param groupKey - Alertmanager group key.
 * @returns SHA-256-based hex identifier.
 */
function deriveAlertId(raw: RawAlert, groupKey: string): string {
  const material = JSON.stringify({
    groupKey,
    labels: raw.labels,
    startsAt: raw.startsAt,
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}