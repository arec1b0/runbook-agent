import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { parseAlertmanagerWebhook } from "../ingest/alertmanager.webhook.js";
import type { AlertPipeline } from "../pipeline/alert.pipeline.js";
import type { ApprovalGate } from "../safety/approval.gate.js";
import type { MetricsRegistry } from "../observability/metrics.js";
import type { IncidentStore } from "../agent/memory/incident.store.js";
import type { Logger } from "../observability/logger.js";

/**
 * Body schema for the approval resolution endpoint.
 */
const ApprovalResolutionSchema = z.object({
  approved: z.boolean(),
});

/**
 * Dependencies required by the HTTP server (constructor injection —
 * the server owns no business logic, only transport concerns).
 */
export interface ServerDependencies {
  readonly pipeline: AlertPipeline;
  readonly gate: ApprovalGate;
  readonly metrics: MetricsRegistry;
  readonly store: IncidentStore;
  readonly logger: Logger;
}

/**
 * Builds the Fastify server with all routes.
 *
 * Endpoints:
 * - POST /webhook/alertmanager  Alertmanager webhook ingestion.
 * - GET  /approvals             List pending approvals.
 * - POST /approvals/:id         Resolve an approval (approve/reject).
 * - GET  /metrics               Prometheus text exposition.
 * - GET  /healthz               Liveness probe.
 *
 * Webhook semantics: the endpoint responds 202 immediately after
 * validation and processes alerts asynchronously. Alertmanager has
 * its own delivery timeout; a pipeline that includes a human approval
 * step must never make the webhook response wait for it.
 *
 * @param deps - Injected dependencies.
 * @returns Configured Fastify instance (not yet listening).
 */
export function buildServer(deps: ServerDependencies): FastifyInstance {
  const app = Fastify({ logger: false });

  app.post("/webhook/alertmanager", (request, reply) => {
    const parsed = parseAlertmanagerWebhook(request.body);

    if (!parsed.ok) {
      deps.logger.warn({ error: parsed.error }, "Rejected invalid webhook");
      return reply.status(400).send({ error: parsed.error });
    }

    // Fire-and-forget with explicit error containment: alert handling
    // continues in the background; the webhook is acknowledged now.
    for (const alert of parsed.alerts) {
      deps.pipeline.handle(alert).catch((error: unknown) => {
        deps.logger.error(
          { error, alertName: alert.name },
          "Pipeline failed unexpectedly"
        );
      });
    }

    return reply
      .status(202)
      .send({ accepted: parsed.alerts.length });
  });

  app.get("/approvals", (_request, reply) => {
    return reply.send({ pending: deps.gate.listPending() });
  });

  app.post("/approvals/:id", (request, reply) => {
    const params = request.params as { id: string };
    const body = ApprovalResolutionSchema.safeParse(request.body);

    if (!body.success) {
      return reply
        .status(400)
        .send({ error: 'Body must be {"approved": true|false}' });
    }

    const resolved = deps.gate.resolveApproval(params.id, body.data.approved);
    if (!resolved) {
      return reply
        .status(404)
        .send({ error: `No pending approval with id "${params.id}"` });
    }

    deps.logger.info(
      { approvalId: params.id, approved: body.data.approved },
      "Approval resolved"
    );
    return reply.send({ id: params.id, approved: body.data.approved });
  });

  app.get("/metrics", (_request, reply) => {
    return reply
      .header("content-type", "text/plain; version=0.0.4")
      .send(deps.metrics.render());
  });

  app.get("/healthz", (_request, reply) => {
    return reply.send({ status: "ok", incidents: deps.store.count });
  });

  return app;
}