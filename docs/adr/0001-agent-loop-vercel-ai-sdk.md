# ADR-0001: Vercel AI SDK for the agent loop

## Status

Accepted (2026-07-13)

## Context

The triage agent needs exactly one LLM capability: a structured decision (`{apply, runbookId, reasoning}`) validated against a schema, from a swappable provider. Candidate frameworks: Vercel AI SDK, LangGraph.js, a raw provider SDK.

Constraints that shaped the decision:

- The agent's authority is deliberately narrow — select one runbook from a closed list or decline. There is no multi-step reasoning graph, no tool-calling loop, no branching agent state.
- Provider swappability (OpenAI/Anthropic) is required for the planned reliability comparison across models.
- The safety chain (validation, approval, rollback) lives in application code and must not depend on framework behavior.

## Decision

Use Vercel AI SDK (`ai` package) with `generateObject` and Zod schemas. Provider selection is isolated in a single factory (`src/agent/llm.provider.ts`) behind the `LanguageModel` interface.

## Consequences

Positive:

- `generateObject` + Zod gives schema-validated structured output with one call; invalid model output surfaces as a typed error we degrade on.
- Providers swap via one config variable; the agent depends only on `LanguageModel` (DIP).
- `MockLanguageModelV1` from `ai/test` lets integration tests exercise the real parsing/validation path without network calls.
- No framework-owned control flow: the pipeline, approval gate, and rollback logic remain plain application code, testable without the framework.

Negative / accepted risks:

- Provider packages must stay on majors compatible with `ai@4.x` (`@ai-sdk/*@1.x`); a mismatched major fails typecheck (observed in practice: a v2 provider implementing `LanguageModelV4` is rejected at compile time — an acceptable failure mode, loud and early).
- If the agent later needs multi-step reasoning with branching and retries, `generateObject` is insufficient. Migration path: introduce LangGraph.js for the reasoning graph while keeping actions, registry, and the safety chain untouched — the `RunbookAction` interface is the stable boundary.

## Alternatives considered

- **LangGraph.js**: graph-based orchestration with branching and retries. Rejected for now: the triage decision is a single structured call; a graph framework would add state and control-flow surface without adding capability (KISS). Revisit if multi-step diagnosis loops are added.
- **Raw provider SDK**: minimal dependencies, but structured output validation, provider abstraction, and test mocks would need to be hand-built — exactly what the AI SDK provides.
- **Encore.ts**: considered for type-safe service-to-service calls; out of scope while the system is a single service. Revisit if the approval UI or ingestion split into separate services.