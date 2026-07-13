import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "../../observability/logger.js";
import type {
  IncidentRecord,
  IncidentSummary,
} from "./incident.types.js";

/**
 * Incident store: in-memory index with append-only JSONL persistence.
 *
 * Design choices (KISS, auditable):
 * - JSONL append is the write path: one line per incident, crash-safe
 *   in the sense that a partial write corrupts at most the last line.
 * - The in-memory index is rebuilt from the file at startup; corrupt
 *   lines are skipped and logged, never fatal.
 * - No external database: the incident history IS the audit log.
 */
export class IncidentStore {
  private readonly incidents: IncidentRecord[] = [];

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger
  ) {}

  /**
   * Loads existing incidents from the JSONL file.
   * Missing file is normal on first run.
   */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      this.logger.info(
        { file: this.filePath },
        "No incident history file; starting empty"
      );
      return;
    }

    let skipped = 0;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        this.incidents.push(JSON.parse(trimmed) as IncidentRecord);
      } catch {
        skipped += 1;
      }
    }

    this.logger.info(
      { loaded: this.incidents.length, skipped },
      "Incident history loaded"
    );
  }

  /**
   * Appends an incident to memory and to the JSONL file.
   * File write failures are logged but never crash the pipeline:
   * losing one history line is preferable to losing the remediation.
   *
   * @param record - Completed incident record.
   */
  async append(record: IncidentRecord): Promise<void> {
    this.incidents.push(record);
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(
        this.filePath,
        `${JSON.stringify(record)}\n`,
        "utf8"
      );
    } catch (error) {
      this.logger.error(
        { error, traceId: record.traceId },
        "Failed to persist incident record"
      );
    }
  }

  /**
   * Returns compact summaries of past incidents most relevant to an
   * alert: same alert name first, then same service, newest first.
   *
   * @param alertName - Alert name to match.
   * @param service - Service name to match, may be null.
   * @param limit - Maximum number of summaries.
   * @returns Relevant incident summaries for LLM context.
   */
  findRelevant(
    alertName: string,
    service: string | null,
    limit: number
  ): readonly IncidentSummary[] {
    const scored = this.incidents
      .map((incident) => ({
        incident,
        score:
          (incident.alert.name === alertName ? 2 : 0) +
          (service !== null && incident.alert.service === service ? 1 : 0),
      }))
      .filter((entry) => entry.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.incident.finishedAt.localeCompare(a.incident.finishedAt)
      )
      .slice(0, limit);

    return scored.map(({ incident }) => ({
      alertName: incident.alert.name,
      severity: incident.alert.severity,
      service: incident.alert.service,
      runbookId: incident.runbookId,
      status: incident.status,
      rolledBack: incident.rolledBack,
      durationSeconds: incident.durationSeconds,
      finishedAt: incident.finishedAt,
    }));
  }

  /**
   * Total number of stored incidents.
   *
   * @returns Incident count.
   */
  get count(): number {
    return this.incidents.length;
  }
}