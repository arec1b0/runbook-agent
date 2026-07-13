/**
 * In-process metrics registry.
 *
 * Deliberately dependency-free (KISS): counters and histograms are kept
 * in memory and exposed in Prometheus text format via an HTTP endpoint.
 * If the project later needs the full prom-client feature set, this
 * module is the single replacement point (SRP + OCP).
 */

interface HistogramState {
  buckets: number[];
  counts: number[];
  sum: number;
  total: number;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, HistogramState>();

  /**
   * Increments a counter by 1 (or a custom delta).
   *
   * @param name - Metric name, e.g. "alerts_received_total".
   * @param delta - Increment value, defaults to 1.
   */
  incrementCounter(name: string, delta = 1): void {
    const current = this.counters.get(name) ?? 0;
    this.counters.set(name, current + delta);
  }

  /**
   * Pre-registers a counter at zero so it is present in the rendered
   * output before the first increment. Prometheus best practice:
   * a counter that appears mid-scrape breaks rate() queries, and an
   * absent metric is indistinguishable from zero.
   *
   * @param name - Metric name to initialize.
   */
  registerCounter(name: string): void {
    if (!this.counters.has(name)) {
      this.counters.set(name, 0);
    }
  }

  /**
   * Registers a histogram with explicit bucket boundaries (seconds).
   *
   * @param name - Metric name, e.g. "action_duration_seconds".
   * @param buckets - Ascending bucket upper bounds.
   */
  registerHistogram(name: string, buckets: number[]): void {
    this.histograms.set(name, {
      buckets: [...buckets].sort((a, b) => a - b),
      counts: new Array<number>(buckets.length).fill(0),
      sum: 0,
      total: 0,
    });
  }

  /**
   * Records an observation into a registered histogram.
   * Unregistered names are ignored to keep the hot path exception-free.
   *
   * @param name - Histogram name.
   * @param value - Observed value in seconds.
   */
  observe(name: string, value: number): void {
    const h = this.histograms.get(name);
    if (!h) {
      return;
    }
    h.sum += value;
    h.total += 1;
    for (let i = 0; i < h.buckets.length; i += 1) {
      const bucket = h.buckets[i];
      if (bucket !== undefined && value <= bucket) {
        const count = h.counts[i];
        h.counts[i] = (count ?? 0) + 1;
      }
    }
  }

  /**
   * Renders all metrics in Prometheus text exposition format.
   *
   * @returns Metrics payload for the /metrics endpoint.
   */
  render(): string {
    const lines: string[] = [];

    for (const [name, value] of this.counters) {
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name} ${value}`);
    }

    for (const [name, h] of this.histograms) {
      lines.push(`# TYPE ${name} histogram`);
      for (let i = 0; i < h.buckets.length; i += 1) {
        const bucket = h.buckets[i];
        const count = h.counts[i];
        if (bucket !== undefined) {
          lines.push(`${name}_bucket{le="${bucket}"} ${count ?? 0}`);
        }
      }
      lines.push(`${name}_bucket{le="+Inf"} ${h.total}`);
      lines.push(`${name}_sum ${h.sum}`);
      lines.push(`${name}_count ${h.total}`);
    }

    return lines.join("\n") + "\n";
  }
}

/**
 * Well-known metric names used across the application.
 * Centralized to prevent typo-driven metric fragmentation (DRY).
 */
export const METRICS = {
  ALERTS_RECEIVED: "alerts_received_total",
  ACTIONS_PROPOSED: "actions_proposed_total",
  ACTIONS_EXECUTED: "actions_executed_total",
  ACTIONS_ROLLED_BACK: "actions_rolled_back_total",
  ACTIONS_REJECTED: "actions_rejected_total",
  ACTION_DURATION_SECONDS: "action_duration_seconds",
  RECOVERY_DURATION_SECONDS: "recovery_duration_seconds",
} as const;

/**
 * Creates a registry pre-populated with the application counters
 * and histograms. Every well-known metric is present at startup,
 * so the /metrics endpoint exposes a stable metric set from the
 * first scrape onward.
 *
 * @returns Ready-to-use metrics registry.
 */
export function createMetrics(): MetricsRegistry {
  const registry = new MetricsRegistry();

  registry.registerCounter(METRICS.ALERTS_RECEIVED);
  registry.registerCounter(METRICS.ACTIONS_PROPOSED);
  registry.registerCounter(METRICS.ACTIONS_EXECUTED);
  registry.registerCounter(METRICS.ACTIONS_ROLLED_BACK);
  registry.registerCounter(METRICS.ACTIONS_REJECTED);

  registry.registerHistogram(METRICS.ACTION_DURATION_SECONDS, [
    0.1, 0.5, 1, 2, 5, 10, 30, 60,
  ]);
  registry.registerHistogram(METRICS.RECOVERY_DURATION_SECONDS, [
    5, 15, 30, 60, 120, 300, 600,
  ]);
  return registry;
}