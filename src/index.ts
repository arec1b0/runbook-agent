import { loadConfig } from "./config/config.js";
import { createLogger } from "./observability/logger.js";
import { createMetrics } from "./observability/metrics.js";
import { RunbookRegistry } from "./runbooks/runbook.registry.js";
import { DEFAULT_RUNBOOKS } from "./runbooks/default.runbooks.js";
import { ExecFileRunner } from "./runbooks/actions/command.runner.js";
import { RestartServiceAction } from "./runbooks/actions/restart-service.action.js";
import { ScaleDeploymentAction } from "./runbooks/actions/scale-deployment.action.js";
import { CollectDiagnosticsAction } from "./runbooks/actions/collect-diagnostics.action.js";
import { ApprovalGate } from "./safety/approval.gate.js";
import { ExecutionEngine } from "./safety/execution.engine.js";
import { createLanguageModel } from "./agent/llm.provider.js";
import { TriageAgent } from "./agent/agent.js";
import { IncidentStore } from "./agent/memory/incident.store.js";
import { AlertPipeline } from "./pipeline/alert.pipeline.js";
import { buildServer } from "./server/http.server.js";

/**
 * Composition root: the ONLY place where concrete implementations
 * are instantiated and wired together. Every other module depends
 * on interfaces and injected collaborators (DIP).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const metrics = createMetrics();

  logger.info(
    {
      provider: config.llmProvider,
      model: config.llmModel,
      mode: config.executionMode,
      port: config.port,
    },
    "Starting runbook-agent"
  );

  if (config.executionMode === "live") {
    logger.warn(
      "LIVE MODE: approved actions WILL mutate cluster state"
    );
  }

  // Runbook layer: actions + runbooks, validated at registration time.
  const runner = new ExecFileRunner();
  const registry = new RunbookRegistry();
  registry.registerAction(new CollectDiagnosticsAction(runner));
  registry.registerAction(new RestartServiceAction(runner));
  registry.registerAction(new ScaleDeploymentAction(runner));
  for (const runbook of DEFAULT_RUNBOOKS) {
    registry.registerRunbook(runbook);
  }

  // Safety layer.
  const gate = new ApprovalGate(config.executionMode, config.approvalTimeoutMs);
  const engine = new ExecutionEngine(
    registry,
    gate,
    metrics,
    config.executionMode === "dry-run"
  );

  // Agent layer.
  const model = createLanguageModel(config);
  const agent = new TriageAgent(model);
  const store = new IncidentStore(config.incidentFilePath, logger);
  await store.load();

  // Pipeline + transport.
  const pipeline = new AlertPipeline(
    registry,
    agent,
    engine,
    store,
    metrics,
    logger
  );
  const server = buildServer({ pipeline, gate, metrics, store, logger });

  // Graceful shutdown: stop accepting webhooks, let in-flight
  // handling finish, then exit. SIGINT covers Ctrl+C on Windows.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down");
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.listen({ port: config.port, host: "0.0.0.0" });
  logger.info({ port: config.port }, "Webhook server listening");
}

main().catch((error: unknown) => {
  // Startup failures print to stderr directly: the logger itself
  // may be the component that failed to initialize.
  console.error("Fatal startup error:", error);
  process.exit(1);
});