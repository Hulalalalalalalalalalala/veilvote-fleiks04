import { randomUUID } from "node:crypto";

/**
 * Privacy-safe runtime observability: per-request correlation ids, single-line
 * structured access logs and in-memory metrics. Nothing here ever sees request
 * bodies, query strings, tokens, commitments, proofs, nullifiers, receipt ids
 * or poll ids — only a fixed, low-cardinality operation vocabulary and the
 * stable error codes the API already returns.
 */

export type Outcome = "success" | "rejected" | "unauthorized" | "error";

/** Per-request scratch space the handler fills while routing. */
export interface ObsContext {
  /** Stable operation name (fixed vocabulary, never derived from ids/paths). */
  operation: string;
  /** Status code actually sent, captured from the json() choke point. */
  statusCode: number;
  /** Stable machine-readable error code, when the response failed. */
  errorCode?: string;
  /** Skip the log line and metrics record (non-API assets and the metrics endpoint itself). */
  skip: boolean;
  /** Whether to attach X-Request-Id to the response (every /api answer, including metrics). */
  header: boolean;
}

export function newRequestId(): string {
  return randomUUID();
}

export function newObsContext(): ObsContext {
  // Static assets are outside the /api observability contract; the handler
  // opts in when routing under /api.
  return { operation: "static", statusCode: 0, skip: true, header: false };
}

const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

/**
 * Only codes from the API's own stable vocabulary are allowed through; this
 * guards against user-controlled text ever reaching the log or metrics.
 */
export function sanitizeErrorCode(code: unknown): string | undefined {
  return typeof code === "string" && ERROR_CODE_PATTERN.test(code) ? code : undefined;
}

export function outcomeFor(statusCode: number): Outcome {
  if (statusCode === 401) return "unauthorized";
  if (statusCode >= 500) return "error";
  if (statusCode >= 200 && statusCode < 300) return "success";
  return "rejected";
}

/**
 * Votes and membership changes are adjudicated inside an immediate SQLite
 * transaction; their log line/metrics carry the low-cardinality admission
 * decision of that transaction: "accepted" on success, "conflict" when the
 * request raced or clashed with persisted state (409), "rejected" for other
 * client failures, plus "unauthorized"/"error". The precise conflict reason
 * stays available through errorCode without inflating this label's cardinality.
 */
export function decisionFor(operation: string, statusCode: number, outcome: Outcome): string | undefined {
  if (operation !== "vote_submit" && operation !== "group_change") return undefined;
  if (outcome === "unauthorized") return "unauthorized";
  if (outcome === "error") return "error";
  if (statusCode >= 200 && statusCode < 300) return "accepted";
  if (statusCode === 409) return "conflict";
  return "rejected";
}

export interface RequestLogEntry {
  at: string;
  requestId: string;
  operation: string;
  statusCode: number;
  outcome: Outcome;
  durationMs: number;
  errorCode?: string;
  decision?: string;
}

interface MetricsBucket {
  count: number;
  sumMs: number;
  maxMs: number;
}

export interface MetricsRow {
  operation: string;
  statusCode: number;
  errorCode: string | null;
  decision: string | null;
  count: number;
  sumMs: number;
  maxMs: number;
}

export interface MetricsReport {
  startedAt: string;
  metrics: MetricsRow[];
}

/**
 * Process-local, non-persistent counters. Node executes event-loop turns to
 * completion, so record() (called from the response "finish" event) never
 * interleaves: concurrent requests cannot lose or corrupt an update.
 */
export class MetricsRegistry {
  readonly startedAt: string;
  private readonly buckets = new Map<string, MetricsBucket>();

  constructor(now: Date = new Date()) {
    this.startedAt = now.toISOString();
  }

  record(entry: RequestLogEntry): void {
    // Empty segments (not the string "null") key buckets that report JSON null.
    const errorCode = entry.errorCode ?? "";
    const decision = decisionFor(entry.operation, entry.statusCode, entry.outcome) ?? "";
    const key = `${entry.operation}|${entry.statusCode}|${errorCode}|${decision}`;
    const bucket = this.buckets.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.sumMs += entry.durationMs;
      if (entry.durationMs > bucket.maxMs) bucket.maxMs = entry.durationMs;
    } else {
      this.buckets.set(key, { count: 1, sumMs: entry.durationMs, maxMs: entry.durationMs });
    }
  }

  snapshot(): MetricsReport {
    const rows: MetricsRow[] = [];
    for (const [key, bucket] of this.buckets) {
      const [operation, statusText, errorCode, decision] = key.split("|") as [string, string, string, string];
      rows.push({
        operation,
        statusCode: Number(statusText),
        errorCode: errorCode ? errorCode : null,
        decision: decision ? decision : null,
        count: bucket.count,
        sumMs: bucket.sumMs,
        maxMs: bucket.maxMs
      });
    }
    rows.sort((a, b) =>
      a.operation.localeCompare(b.operation) ||
      a.statusCode - b.statusCode ||
      (a.errorCode ?? "").localeCompare(b.errorCode ?? "") ||
      (a.decision ?? "").localeCompare(b.decision ?? "")
    );
    return { startedAt: this.startedAt, metrics: rows };
  }
}

/** Emit one single-line JSON record. A logging failure never reaches callers. */
export function emitRequestLog(sink: (line: string) => void, entry: RequestLogEntry): void {
  try {
    sink(`${JSON.stringify(entry)}\n`);
  } catch {
    // Observability must never alter a business response.
  }
}
