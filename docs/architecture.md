## Layers

### Ingest (`src/ingest/`)

Parses Alertmanager v4 webhook payloads with Zod. Produces `NormalizedAlert` — the only alert representation the rest of the system knows. Parsing returns a discriminated union instead of throwing: validation failure on the hot path is data, not an exception. Alerts without a fingerprint get a deterministic SHA-256-derived id, so Alertmanager delivery retries never create duplicate incidents. Unrecognized severities normalize to `unknown`, which never qualifies for remediation runbooks.

### Runbooks (`src/runbooks/`)

`RunbookAction<TInput>` is the single abstraction the agent layer depends on. Contract (enforced by tests):

1. `execute` respects `ctx.dryRun`: no side effects when true.
2. `execute` never throws; failures are returned as `ActionResult`.
3. `reversible` actions implement `rollback` that undoes the last execute.
4. `inputSchema` fully validates input before execution.

Actions are risk-classified: `read-only` (diagnostics), `reversible` (scaling — prior replica count captured and restorable), `disruptive` (restart — no inverse exists, rollback intentionally absent).

External commands go through the `CommandRunner` interface. Production uses `execFile` with an argv array — no shell interpretation, therefore no injection surface even if the LLM produced a hostile deployment name. Tests inject a fake runner.

`RunbookRegistry` validates every runbook step against registered actions at registration time: a broken configuration fails at deploy, not mid-incident.

### Agent (`src/agent/`)

`TriageAgent` wraps one `generateObject` call with four containment layers:

1. Only runbooks whose matchers accepted the alert are offered as candidates.
2. The output schema forces `{apply, runbookId, reasoning}`.
3. A returned id outside the candidate list is treated as a decline — disobedience never converts into authority.
4. LLM call failures degrade to a decline with reasoning `"Triage unavailable"`.

The planner is deterministic: parameters are derived from alert labels (`service` -> `deployment`, `namespace` -> `namespace`), and alert-derived values override static runbook params. The blast radius of a bad LLM decision is bounded to runbook selection.

`IncidentStore` is an append-only JSONL file with an in-memory index. One line per incident; a partial write corrupts at most the last line; corrupt lines are skipped at load. The history file *is* the audit log. `findRelevant` scores past incidents by alert name and service, and compact summaries (without raw diagnostics output) are fed into the triage prompt.

### Safety (`src/safety/`)

`ApprovalGate` policy: dry-run auto-approves everything (no side effects exist); live mode auto-approves only `read-only`; everything else waits for a human via the HTTP API. Requests time out into rejection — silence is denial.

`ExecutionEngine` runs each step through: input validation -> gate -> execute -> record for rollback. The first non-executed outcome (unknown action, invalid input, rejection, failure) stops the plan and triggers rollback of all previously executed reversible steps. Input validation runs *before* the gate: a human approver is never shown an invalid action.

`RollbackManager` is scoped to one pipeline run (like a transaction owning its own undo log). Rollback is LIFO and continues past individual rollback failures.

### Pipeline (`src/pipeline/`)

`AlertPipeline` orchestrates the sequence and converts every failure mode into an `IncidentRecord` with an explicit status: `remediated`, `diagnostics-only`, `failed`, `rejected`, `no-runbook`. Resolved alerts are recorded but never remediated. The pipeline never throws.

### Transport (`src/server/`)

Fastify server owning no business logic. The webhook responds 202 after validation and processes asynchronously, because a plan with a human approval step can take minutes while Alertmanager retries on timeout.

### Composition root (`src/index.ts`)

The only place where concrete implementations are instantiated and wired. Registration order matters: actions before runbooks, because the registry validates step references at registration.

## Observability

- Every alert receives a `traceId` at ingestion; every triage decision, approval, execution, and rollback logs with it. The full decision chain is reconstructable from logs alone.
- The logger redacts API keys and authorization headers by path, so accidentally logging a config object cannot leak credentials.
- All well-known counters are pre-registered at zero: the `/metrics` endpoint exposes a stable metric set from the first scrape, so `rate()` queries and dashboards work before the first incident.

## Failure modes and behavior

| Failure                          | Behavior                                                        |
| -------------------------------- | --------------------------------------------------------------- |
| Invalid webhook payload          | 400 with details; nothing enters the pipeline                   |
| LLM provider down                | Incident recorded as `no-runbook`, "escalate to human"          |
| LLM returns unknown runbook id   | Treated as decline; zero steps executed                         |
| Action input fails validation    | Plan stops before the approval gate; rollback of prior steps    |
| Human rejects or approval times out | Plan stops; rollback of prior steps                          |
| Action execution fails           | Plan stops; rollback of prior steps (LIFO, best-effort)         |
| Rollback step fails              | Logged; remaining rollback steps still attempted                |
| Incident file write fails        | Logged; remediation outcome is never sacrificed for history     |
| Resolved alert arrives           | Recorded; never remediated                                      |