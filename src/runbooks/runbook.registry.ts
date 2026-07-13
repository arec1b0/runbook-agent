import type { NormalizedAlert, Severity } from "../ingest/alert.types.js";
import type { RunbookAction } from "./action.interface.js";
import type { Runbook, RunbookMatcher } from "./runbook.types.js";

/**
 * Severity ordering for minSeverity matching.
 * Higher value = more severe. "unknown" is the lowest and never
 * satisfies any minSeverity requirement.
 */
const SEVERITY_RANK: Record<Severity, number> = {
  unknown: 0,
  info: 1,
  warning: 2,
  critical: 3,
};

/**
 * Registry of actions and runbooks.
 *
 * Single source of truth for what the agent is allowed to do:
 * the agent can only propose actions that exist here, and only
 * through runbooks whose matchers accept the alert (capability
 * containment — the LLM never invents arbitrary operations).
 */
export class RunbookRegistry {
  private readonly actions = new Map<string, RunbookAction>();
  private readonly runbooks = new Map<string, Runbook>();

  /**
   * Registers an action. Duplicate ids are a programming error and
   * fail fast at startup.
   *
   * @param action - Action implementation to register.
   */
  registerAction(action: RunbookAction): void {
    if (this.actions.has(action.id)) {
      throw new Error(`Duplicate action id: ${action.id}`);
    }
    this.actions.set(action.id, action);
  }

  /**
   * Registers a runbook after verifying every referenced action exists.
   *
   * @param runbook - Runbook definition to register.
   */
  registerRunbook(runbook: Runbook): void {
    if (this.runbooks.has(runbook.id)) {
      throw new Error(`Duplicate runbook id: ${runbook.id}`);
    }
    for (const step of runbook.steps) {
      if (!this.actions.has(step.actionId)) {
        throw new Error(
          `Runbook "${runbook.id}" references unknown action "${step.actionId}"`
        );
      }
    }
    this.runbooks.set(runbook.id, runbook);
  }

  /**
   * Returns an action by id, or null if not registered.
   *
   * @param id - Action identifier.
   * @returns The action or null.
   */
  getAction(id: string): RunbookAction | null {
    return this.actions.get(id) ?? null;
  }

  /**
   * Finds all runbooks whose matchers accept the given alert.
   *
   * @param alert - Normalized alert.
   * @returns Matching runbooks in registration order.
   */
  findMatching(alert: NormalizedAlert): readonly Runbook[] {
    const result: Runbook[] = [];
    for (const runbook of this.runbooks.values()) {
      if (matches(runbook.matcher, alert)) {
        result.push(runbook);
      }
    }
    return result;
  }

  /**
   * Lists all registered actions (for agent tool exposure).
   *
   * @returns All actions in registration order.
   */
  listActions(): readonly RunbookAction[] {
    return [...this.actions.values()];
  }
}

/**
 * Evaluates a matcher against an alert.
 *
 * @param matcher - Runbook matching rule.
 * @param alert - Normalized alert.
 * @returns True when every specified condition holds.
 */
function matches(matcher: RunbookMatcher, alert: NormalizedAlert): boolean {
  if (matcher.alertName !== undefined && matcher.alertName !== alert.name) {
    return false;
  }

  if (matcher.minSeverity !== undefined) {
    const required = SEVERITY_RANK[matcher.minSeverity];
    const actual = SEVERITY_RANK[alert.severity];
    if (alert.severity === "unknown" || actual < required) {
      return false;
    }
  }

  if (matcher.labels !== undefined) {
    for (const [key, value] of Object.entries(matcher.labels)) {
      if (alert.labels[key] !== value) {
        return false;
      }
    }
  }

  return true;
}