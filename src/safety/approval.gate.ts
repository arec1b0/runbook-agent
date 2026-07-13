import type { ActionRisk } from "../runbooks/action.interface.js";
import type { ExecutionMode } from "../config/schema.js";

/**
 * Approval decision for a proposed action.
 */
export type ApprovalDecision =
  | { readonly kind: "auto-approved"; readonly reason: string }
  | { readonly kind: "requires-approval"; readonly reason: string }
  | { readonly kind: "denied"; readonly reason: string };

/**
 * A pending approval request awaiting a human decision.
 */
export interface PendingApproval {
  /** Unique approval request id. */
  readonly id: string;

  /** Action id being approved. */
  readonly actionId: string;

  /** Action input, shown to the approver. */
  readonly input: Readonly<Record<string, unknown>>;

  /** Risk classification of the action. */
  readonly risk: ActionRisk;

  /** Trace id linking this approval to the alert pipeline. */
  readonly traceId: string;

  /** ISO timestamp when the request was created. */
  readonly createdAt: string;

  /** Resolves the request: true = approved, false = rejected. */
  readonly resolve: (approved: boolean) => void;
}

/**
 * Policy gate deciding whether an action may execute.
 *
 * Policy (deliberately simple and auditable — KISS):
 * - dry-run mode: everything is auto-approved (no side effects exist).
 * - live mode, read-only risk: auto-approved.
 * - live mode, reversible or disruptive risk: requires explicit
 *   human approval, delivered via the HTTP API.
 *
 * Approval requests time out and are denied after `timeoutMs`:
 * an unanswered approval must never block the pipeline forever,
 * and silence must never mean consent.
 */
export class ApprovalGate {
  private readonly pending = new Map<string, PendingApproval>();
  private counter = 0;

  constructor(
    private readonly mode: ExecutionMode,
    private readonly timeoutMs: number
  ) {}

  /**
   * Evaluates the static policy for an action risk level.
   *
   * @param risk - Action risk classification.
   * @returns Approval decision (before any human interaction).
   */
  evaluate(risk: ActionRisk): ApprovalDecision {
    if (this.mode === "dry-run") {
      return {
        kind: "auto-approved",
        reason: "dry-run mode: no side effects possible",
      };
    }
    if (risk === "read-only") {
      return {
        kind: "auto-approved",
        reason: "read-only action: no state change",
      };
    }
    return {
      kind: "requires-approval",
      reason: `${risk} action in live mode requires human approval`,
    };
  }

  /**
   * Creates a pending approval and waits for a human decision.
   * Resolves false on timeout (silence is denial).
   *
   * @param actionId - Action to approve.
   * @param input - Action input shown to the approver.
   * @param risk - Risk classification.
   * @param traceId - Pipeline trace id.
   * @returns True when approved, false when rejected or timed out.
   */
  async requestApproval(
    actionId: string,
    input: Readonly<Record<string, unknown>>,
    risk: ActionRisk,
    traceId: string
  ): Promise<boolean> {
    this.counter += 1;
    const id = `apr-${String(this.counter).padStart(6, "0")}`;

    return new Promise<boolean>((resolvePromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolvePromise(false);
      }, this.timeoutMs);

      const entry: PendingApproval = {
        id,
        actionId,
        input,
        risk,
        traceId,
        createdAt: new Date().toISOString(),
        resolve: (approved: boolean) => {
          clearTimeout(timer);
          this.pending.delete(id);
          resolvePromise(approved);
        },
      };

      this.pending.set(id, entry);
    });
  }

  /**
   * Lists pending approvals (for the HTTP API).
   *
   * @returns Pending approvals without the resolve callback.
   */
  listPending(): readonly Omit<PendingApproval, "resolve">[] {
    return [...this.pending.values()].map(
      ({ resolve: _resolve, ...rest }) => rest
    );
  }

  /**
   * Resolves a pending approval by id.
   *
   * @param id - Approval request id.
   * @param approved - Human decision.
   * @returns True when the id existed and was resolved.
   */
  resolveApproval(id: string, approved: boolean): boolean {
    const entry = this.pending.get(id);
    if (!entry) {
      return false;
    }
    entry.resolve(approved);
    return true;
  }
}