import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import type { NormalizedAlert } from "../ingest/alert.types.js";
import type { Runbook } from "../runbooks/runbook.types.js";
import type { Logger } from "../observability/logger.js";
import type { TraceContext } from "../observability/trace.js";
import type { IncidentSummary } from "./memory/incident.types.js";
import {
  TRIAGE_SYSTEM_PROMPT,
  buildTriagePrompt,
} from "./prompts/triage.prompt.js";

/**
 * Structured triage decision produced by the LLM.
 */
const TriageDecisionSchema = z.object({
  /** Whether any runbook should be applied. */
  apply: z.boolean(),

  /** Chosen runbook id; must be one of the candidates. Null when apply=false. */
  runbookId: z.string().nullable(),

  /** 2-4 sentence factual justification. */
  reasoning: z.string().min(1),
});
export type TriageDecision = z.infer<typeof TriageDecisionSchema>;

/**
 * Triage agent: wraps the LLM call and hardens its output.
 *
 * Containment layers, in order:
 * 1. Only runbooks whose matchers accepted the alert are offered.
 * 2. The output schema forces a boolean decision + id + reasoning.
 * 3. The returned id is verified against the candidate list; an id
 *    outside it is treated as a decline, not an error to retry —
 *    a model that ignores instructions must not gain authority by it.
 * 4. LLM failures degrade to "decline": the pipeline then records
 *    the incident as unhandled instead of crashing.
 */
export class TriageAgent {
  constructor(private readonly model: LanguageModel) {}

  /**
   * Makes a triage decision for an alert.
   *
   * @param alert - Normalized alert.
   * @param candidates - Matching runbooks from the registry.
   * @param history - Relevant past incident summaries.
   * @param logger - Pipeline logger.
   * @param trace - Pipeline trace context.
   * @returns Validated triage decision (never throws).
   */
  async triage(
    alert: NormalizedAlert,
    candidates: readonly Runbook[],
    history: readonly IncidentSummary[],
    logger: Logger,
    trace: TraceContext
  ): Promise<TriageDecision> {
    if (candidates.length === 0) {
      return {
        apply: false,
        runbookId: null,
        reasoning: "No runbook matcher accepted this alert.",
      };
    }

    let decision: TriageDecision;
    try {
      const response = await generateObject({
        model: this.model,
        schema: TriageDecisionSchema,
        system: TRIAGE_SYSTEM_PROMPT,
        prompt: buildTriagePrompt(alert, candidates, history),
      });
      decision = response.object;
    } catch (error) {
      logger.error(
        { trace, error },
        "LLM triage call failed; declining remediation"
      );
      return {
        apply: false,
        runbookId: null,
        reasoning: "Triage unavailable: LLM call failed; escalate to human.",
      };
    }

    if (decision.apply) {
      const known = candidates.some(
        (candidate) => candidate.id === decision.runbookId
      );
      if (!known) {
        logger.warn(
          { trace, runbookId: decision.runbookId },
          "LLM chose a runbook outside the candidate list; declining"
        );
        return {
          apply: false,
          runbookId: null,
          reasoning:
            "Model selected an unknown runbook id; declined for safety.",
        };
      }
    }

    logger.info(
      { trace, apply: decision.apply, runbookId: decision.runbookId },
      "Triage decision made"
    );
    return decision;
  }
}