# runbook-agent

A DevOps/SRE runbook agent: it ingests Prometheus Alertmanager alerts, triages them with an LLM against a closed set of pre-approved runbooks, and executes remediation steps through a safety chain of input validation, human approval, and automatic rollback.

Every action is a typed, risk-classified, reversible-where-possible step with a full audit trail. The LLM selects *which* runbook applies; it never composes arbitrary operations and never chooses execution parameters.

## Design principles

- **Capability containment.** The agent can only propose actions registered in the `RunbookRegistry`, and only through runbooks whose matchers accept the alert. A model that returns an unknown runbook id is treated as declining, not as an error to retry.
- **Separation of powers.** The LLM decides *which* runbook (selection from a closed candidate list). The deterministic planner decides *with what parameters* (derived from alert labels, never from model output). The execution engine decides *whether it may run* (approval gate).
- **Reversibility.** Reversible actions capture prior state and provide rollback. A failed plan rolls back all previously executed reversible steps in LIFO order. Failed rollback of one step never blocks rollback of earlier steps.
- **Silence is denial.** Approval requests time out and resolve to rejection. An unanswered approval never blocks the pipeline and never converts into consent.
- **Graceful degradation.** LLM failures degrade to "escalate to human" with a recorded incident. An incident handler that crashes during an incident is the worst possible outcome; the pipeline never throws.
- **Dry-run by default.** `EXECUTION_MODE=dry-run` is the default. Live mode is an explicit, logged decision.

## Quick start

Requirements: Node.js >= 22, pnpm 9, an OpenAI or Anthropic API key. `kubectl` is only needed for live mode.

```powershell
git clone <repository-url>
cd runbook-agent
pnpm install
Copy-Item .env.example .env
# Edit .env: set OPENAI_API_KEY (or switch LLM_PROVIDER to anthropic)
pnpm dev
```

Send a test alert from a second terminal:

```powershell
.\scripts\send-test-alert.ps1
Get-Content data\incidents.jsonl
```

Expected: the webhook responds `{"accepted":1}` and a new JSONL line appears with `status: "remediated"` (both steps simulated in dry-run) or `status: "no-runbook"` with the model's reasoning.

## HTTP API

| Method | Path                    | Purpose                                        |
| ------ | ----------------------- | ---------------------------------------------- |
| POST   | `/webhook/alertmanager` | Alertmanager v4 webhook ingestion (returns 202) |
| GET    | `/approvals`            | List pending approval requests                 |
| POST   | `/approvals/:id`        | Resolve an approval: `{"approved": true\|false}` |
| GET    | `/metrics`              | Prometheus text exposition                     |
| GET    | `/healthz`              | Liveness probe with incident count             |

The webhook responds `202 Accepted` immediately after validation and processes alerts asynchronously: a plan containing a human approval step may take minutes, while Alertmanager retries on delivery timeout. Synchronous handling would cause duplicate processing.

## Configuration

All configuration is validated at startup; the process fails fast with an aggregated error on invalid values. See `.env.example` for the full list.

| Variable              | Default                 | Description                                  |
| --------------------- | ----------------------- | -------------------------------------------- |
| `LLM_PROVIDER`        | `openai`                | `openai` or `anthropic`                      |
| `LLM_MODEL`           | `gpt-4o`                | Model identifier for the selected provider   |
| `OPENAI_API_KEY`      | —                       | Required when `LLM_PROVIDER=openai`          |
| `ANTHROPIC_API_KEY`   | —                       | Required when `LLM_PROVIDER=anthropic`       |
| `PORT`                | `3000`                  | Webhook server port                          |
| `EXECUTION_MODE`      | `dry-run`               | `dry-run` (simulate) or `live` (execute)     |
| `LOG_LEVEL`           | `info`                  | pino log level                               |
| `APPROVAL_TIMEOUT_MS` | `300000`                | Approval timeout; expiry means rejection     |
| `INCIDENT_FILE_PATH`  | `data/incidents.jsonl`  | Append-only JSONL incident history           |

## Approval flow (live mode)

Risk policy: `read-only` actions auto-execute; `reversible` and `disruptive` actions require explicit human approval.

```powershell
# List pending approvals
Invoke-RestMethod -Uri "http://localhost:3000/approvals" -Method Get

# Approve
Invoke-RestMethod -Uri "http://localhost:3000/approvals/apr-000001" `
  -Method Post -ContentType "application/json" -Body '{"approved": true}'
```

## Built-in runbooks

| Runbook               | Matcher                              | Steps                                        |
| --------------------- | ------------------------------------ | -------------------------------------------- |
| `investigate-unknown` | any alert                            | collect-diagnostics                          |
| `oom-restart`         | `OOMKilled`, severity >= warning     | collect-diagnostics → restart-service        |
| `high-load-scale-up`  | `HighRequestLatency`, severity critical | collect-diagnostics → scale-deployment (5) |

`investigate-unknown` matches every alert by design: the triage agent always has a safe diagnostics-only option among its candidates. Alerts with unknown severity never match remediation runbooks.

## Reliability metrics

Exposed at `/metrics` and derivable from the JSONL incident history:

- `alerts_received_total`, `actions_proposed_total`, `actions_executed_total`
- `actions_rejected_total`, `actions_rolled_back_total`
- `action_duration_seconds`, `recovery_duration_seconds` (histograms)

The incident history is the primary dataset for reliability analysis: autonomous remediation rate vs. human escalation rate, recovery duration distribution, and rollback rate per runbook. Incidents where the LLM provider itself failed are recorded (status `no-runbook`, reasoning `"Triage unavailable"`) — provider failure during an incident is a legitimate scenario to measure, not noise to discard.

## Development

```powershell
pnpm dev            # watch mode with .env loading
pnpm test           # unit + integration tests (mocked LLM, no network)
pnpm test:coverage  # with coverage report
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint (strict type-checked)
pnpm build          # compile to dist/
```

Integration tests use `MockLanguageModelV1` from `ai/test`: the real `generateObject` parsing and schema validation path is exercised; only token generation is faked.

## Docker

```powershell
docker compose up --build
```

The container runs as a non-root user, ships a version-pinned `kubectl`, and persists incident history in the `incident-data` volume. The kubeconfig mount is commented out by default: in dry-run mode the container has neither credentials nor any physical path to the cluster.

## Documentation

- [Architecture](docs/architecture.md) — components, data flow, safety invariants.
- [ADR-0001](docs/adr/0001-agent-loop-vercel-ai-sdk.md) — agent loop framework decision.