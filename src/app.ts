import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { verifyProof, type SemaphoreProof } from "@semaphore-protocol/proof";
import { openCatalog, STATUSES, type AuditQuery, type GroupOperation, type NewPollInput } from "./store.ts";
import { isCommitment, isProofPayload, terminateProverWorkers, textToField } from "./voting.ts";
import { parseInstant } from "./time.ts";
import type { AuditEvent, PollStatus } from "./types.ts";

const MAX_BODY_BYTES = 1_000_000;

export interface AppOptions {
  /** When unset (or empty) every administrative request is refused with 401. */
  adminToken?: string;
  /** Sink for the single-line JSON request log; defaults to console.log. */
  logger?: (line: string) => void;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { rejectPromise(new Error("body_too_large")); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    request.on("error", rejectPromise);
  });
}

function isNonEmptyString(value: unknown, maxLength = 2000): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

type RequestOutcome = "success" | "rejected" | "unauthorized" | "error";

/**
 * The privacy-safe request log record: route template, status and stable
 * machine codes only. It never carries bodies, raw query strings, tokens,
 * identity secrets, commitments, proofs, nullifiers, receipt ids or poll ids.
 */
interface RequestLogEntry {
  at: string;
  requestId: string;
  operation: string;
  statusCode: number;
  outcome: RequestOutcome;
  durationMs: number;
  errorCode?: string;
  decision?: string;
}

/** Mutable per-request observation the routing code fills in as it decides. */
interface Observation {
  operation: string;
  errorCode?: string;
  decision?: string;
}

interface MetricBucket {
  operation: string;
  statusCode: number;
  errorCode?: string;
  decision?: string;
  count: number;
  sumMs: number;
  maxMs: number;
}

function outcomeOf(statusCode: number): RequestOutcome {
  if (statusCode === 401) return "unauthorized";
  if (statusCode >= 500) return "error";
  if (statusCode >= 400) return "rejected";
  return "success";
}

function sendJson(response: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(payload));
}

export function createApp(databasePath: string, publicPath = resolve("dist/public"), options: AppOptions = {}) {
  const catalog = openCatalog(databasePath);
  const adminToken = options.adminToken && options.adminToken.length > 0 ? options.adminToken : undefined;
  const logger = options.logger ?? ((line: string) => console.log(line));
  let proverUsed = false;
  const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8" };

  // --- Runtime observability (in-memory, reset on restart) -----------------
  const startedAt = new Date().toISOString();
  // Proof-engine health as observed by vote verification: idle until the first
  // verification, ok after any completed verification (a successful run clears
  // an earlier failure), error after the engine itself threw.
  let proofEngine: { status: "idle" | "ok" | "error"; errorCode?: string } = { status: "idle" };
  const metricBuckets = new Map<string, MetricBucket>();

  function recordMetrics(entry: RequestLogEntry) {
    // The metrics endpoint never counts itself; every other /api request does.
    if (entry.operation === "admin_metrics") return;
    const key = JSON.stringify([entry.operation, entry.statusCode, entry.errorCode ?? null, entry.decision ?? null]);
    const bucket = metricBuckets.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.sumMs += entry.durationMs;
      bucket.maxMs = Math.max(bucket.maxMs, entry.durationMs);
    } else {
      metricBuckets.set(key, {
        operation: entry.operation, statusCode: entry.statusCode,
        ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
        ...(entry.decision ? { decision: entry.decision } : {}),
        count: 1, sumMs: entry.durationMs, maxMs: entry.durationMs
      });
    }
  }

  function metricsSnapshot(): MetricBucket[] {
    return [...metricBuckets.values()].sort((a, b) =>
      a.operation.localeCompare(b.operation) || a.statusCode - b.statusCode ||
      (a.errorCode ?? "").localeCompare(b.errorCode ?? "") || (a.decision ?? "").localeCompare(b.decision ?? "")
    ).map(bucket => ({ ...bucket }));
  }

  /**
   * Emits the single-line JSON log for a finished /api request and folds it
   * into the in-memory metrics. A logging failure must never change the
   * business response, so the sink is called behind a guard.
   */
  function observe(observation: Observation, requestId: string, statusCode: number, startedMs: number) {
    const entry: RequestLogEntry = {
      at: new Date().toISOString(),
      requestId,
      operation: observation.operation,
      statusCode,
      outcome: outcomeOf(statusCode),
      durationMs: Math.max(0, Date.now() - startedMs),
      ...(observation.errorCode ? { errorCode: observation.errorCode } : {}),
      ...(observation.decision ? { decision: observation.decision } : {})
    };
    recordMetrics(entry);
    try { logger(JSON.stringify(entry)); } catch { /* logging never affects the response */ }
  }

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      if (!response.writableEnded) response.end(JSON.stringify({ error: "internal_error" }));
    });
  });
  server.on("close", () => {
    catalog.close();
    // Release the snarkjs worker pool so the process can exit.
    if (proverUsed) void terminateProverWorkers();
  });
  return server;

  /**
   * Authorization gate for management endpoints. A missing, wrong or
   * unconfigured token is refused with 401 admin_unauthorized. The check
   * runs before the body is read and never mutates data or writes audit.
   */
  function isAuthorized(request: IncomingMessage): boolean {
    if (!adminToken) return false;
    const provided = request.headers["x-admin-token"];
    if (typeof provided !== "string") return false;
    const expected = Buffer.from(adminToken);
    const actual = Buffer.from(provided);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /**
   * Every /api request gets a server-generated request id (a client-supplied
   * X-Request-Id is ignored), is answered with that id in X-Request-Id and
   * leaves exactly one single-line JSON log record when it finishes —
   * including rejections, unauthorized calls and internal errors.
   */
  async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL, segments: string[]) {
    const requestId = randomUUID();
    response.setHeader("X-Request-Id", requestId);
    const observation: Observation = { operation: "unknown_route" };
    const startedMs = Date.now();
    function json(status: number, payload: unknown, headers: Record<string, string> = {}) {
      if (status >= 400 && typeof payload === "object" && payload !== null && typeof (payload as { error?: unknown }).error === "string") {
        observation.errorCode = (payload as { error: string }).error;
      }
      sendJson(response, status, payload, headers);
    }
    function requireAdmin(): boolean {
      if (isAuthorized(request)) return true;
      json(401, { error: "admin_unauthorized" });
      return false;
    }
    try {
      const method = request.method ?? "GET";
      if (url.pathname === "/api/health") {
        // Liveness only: the process is up. Dependency health is /api/ready.
        observation.operation = "health";
        if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
        return json(200, { service: "veilvote", status: "ok" });
      }
      if (url.pathname === "/api/ready") {
        observation.operation = "ready";
        if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
        // Checks carry only a dependency name, a status and a stable error
        // code — never paths, stacks or driver messages.
        const checks: Record<string, { status: string; errorCode?: string }> = {
          sqlite: catalog.ping() ? { status: "ok" } : { status: "error", errorCode: "sqlite_unavailable" },
          proofEngine: proofEngine.status === "error"
            ? { status: "error", errorCode: proofEngine.errorCode ?? "proof_engine_error" }
            : { status: proofEngine.status }
        };
        const ready = checks.sqlite.status !== "error" && checks.proofEngine.status !== "error";
        return json(ready ? 200 : 503, { service: "veilvote", status: ready ? "ready" : "not_ready", checks });
      }
      if (segments[1] === "admin" && segments[2] === "audit" && segments.length === 3) {
        observation.operation = "audit_query";
        if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
        if (!requireAdmin()) return;
        const query = parseAuditQuery(url.searchParams);
        if (!query.ok) return json(400, { error: query.error });
        return json(200, catalog.auditQuery(query.query));
      }
      if (segments[1] === "admin" && segments[2] === "metrics" && segments.length === 3) {
        observation.operation = "admin_metrics";
        if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
        if (!requireAdmin()) return;
        return json(200, { service: "veilvote", startedAt, metrics: metricsSnapshot() });
      }
      if (segments[1] === "polls" && segments.length <= 4) {
        if (segments.length === 2) {
          // Public catalog list; creating a poll is admin-only and starts in draft.
          if (method === "GET") {
            observation.operation = "poll_list";
            return json(200, { polls: catalog.list(Date.now(), isAuthorized(request)) });
          }
          observation.operation = "poll_create";
          if (method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "GET, POST" });
          if (!requireAdmin()) return;
          let body: unknown;
          try { body = JSON.parse(await readBody(request)); }
          catch {
            catalog.auditFailure("poll_create", "unknown", { reason: "invalid_json" });
            return json(400, { error: "invalid_json" });
          }
          const parsed = parseNewPoll(body);
          if (!parsed.ok) {
            catalog.auditFailure("poll_create", parsed.pollId, { reason: parsed.reason });
            return json(400, { error: parsed.reason });
          }
          const outcome = catalog.createPoll(parsed.input);
          if (!outcome.ok) {
            catalog.auditFailure("poll_create", parsed.input.id, { reason: "poll_exists" });
            return json(409, { error: "poll_exists" });
          }
          return json(201, { poll: outcome.poll });
        }
        let id: string;
        try { id = decodeURIComponent(segments[2]); }
        catch { return json(400, { error: "invalid_poll_id" }); }
        if (segments.length === 3) {
          observation.operation = "poll_get";
          if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
          const poll = catalog.get(id);
          // Drafts are invisible to ordinary detail requests; an authorized
          // manager can still read them to prepare the opening.
          if (!poll || (poll.status === "draft" && !isAuthorized(request))) return json(404, { error: "poll_not_found" });
          return json(200, { poll });
        }
        if (segments[3] === "results") {
          observation.operation = "poll_results";
          if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
          const result = catalog.results(id);
          return result ? json(200, { result }) : json(404, { error: "poll_not_found" });
        }
        if (segments[3] === "status") {
          observation.operation = "status_change";
          if (method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });
          if (!requireAdmin()) return;
          let body: unknown;
          try { body = JSON.parse(await readBody(request)); }
          catch {
            catalog.auditFailure("status_change_rejected", id, { reason: "invalid_json" });
            return json(400, { error: "invalid_json" });
          }
          if (typeof body !== "object" || body === null) {
            catalog.auditFailure("status_change_rejected", id, { reason: "invalid_status" });
            return json(400, { error: "invalid_status" });
          }
          const { status, expectedStatus } = body as { status?: unknown; expectedStatus?: unknown };
          if (!isStatus(status) || !isStatus(expectedStatus)) {
            catalog.auditFailure("status_change_rejected", id, { reason: "invalid_status", requested: String(status), expected: String(expectedStatus) });
            return json(400, { error: "invalid_status" });
          }
          const outcome = catalog.transitionStatus(id, status, expectedStatus);
          if (!outcome.ok) {
            if (outcome.reason === "poll_missing") return json(404, { error: "poll_not_found" });
            if (outcome.reason === "invalid_status") return json(400, { error: "invalid_status" });
            return json(409, { error: outcome.reason });
          }
          const poll = catalog.get(id);
          return json(200, { status: outcome.status, poll });
        }
        if (segments[3] === "group") {
          observation.operation = "group_change";
          if (method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });
          if (!requireAdmin()) return;
          let body: unknown;
          try { body = JSON.parse(await readBody(request)); }
          catch {
            catalog.auditFailure("group_change_rejected", id, { reason: "invalid_json" });
            return json(400, { error: "invalid_json" });
          }
          if (typeof body !== "object" || body === null) {
            catalog.auditFailure("group_change_rejected", id, { reason: "invalid_group_operation" });
            return json(400, { error: "invalid_group_operation" });
          }
          const { operation, expectedVersion, commitment, oldCommitment, newCommitment } = body as Record<string, unknown>;
          if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1) {
            catalog.auditFailure("group_change_rejected", id, { operation: String(operation), reason: "invalid_group_operation" });
            return json(400, { error: "invalid_group_operation" });
          }
          let groupOperation: GroupOperation;
          if (operation === "join" && isCommitment(commitment)) groupOperation = { type: "join", commitment };
          else if (operation === "rotate" && isCommitment(oldCommitment) && isCommitment(newCommitment)) groupOperation = { type: "rotate", oldCommitment, newCommitment };
          else if (operation === "revoke" && isCommitment(commitment)) groupOperation = { type: "revoke", commitment };
          else {
            catalog.auditFailure("group_change_rejected", id, { operation: String(operation), reason: "invalid_group_operation" });
            return json(400, { error: "invalid_group_operation" });
          }
          const outcome = catalog.applyGroupOperation(id, groupOperation, expectedVersion as number);
          if (!outcome.ok) {
            // Concurrency adjudications (frozen group, stale version, poll no
            // longer editable) are recorded as the request's decision.
            if (outcome.reason === "group_frozen" || outcome.reason === "group_version_changed" || outcome.reason === "poll_not_editable") {
              observation.decision = outcome.reason;
              return json(409, { error: outcome.reason });
            }
            if (outcome.reason === "poll_missing") return json(404, { error: "poll_not_found" });
            return json(400, { error: outcome.reason });
          }
          observation.decision = "applied";
          return json(201, { group: outcome.group });
        }
        if (segments[3] === "votes") {
          observation.operation = "vote_cast";
          if (method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });
          const poll = catalog.get(id);
          // Drafts are invisible to the public (404), matching detail/results.
          if (!poll || poll.status === "draft") return json(404, { error: "poll_not_found" });
          let body: unknown;
          try { body = JSON.parse(await readBody(request)); }
          catch { return json(400, { error: "invalid_json" }); }
          if (typeof body !== "object" || body === null) return json(400, { error: "invalid_vote" });
          const { optionId, proof, groupVersion } = body as { optionId?: unknown; proof?: unknown; groupVersion?: unknown };
          if (typeof optionId !== "string" || optionId.length === 0 || !isProofPayload(proof)) {
            return json(400, { error: "invalid_vote" });
          }
          if (groupVersion !== undefined && (!Number.isInteger(groupVersion) || (groupVersion as number) < 1)) {
            return json(400, { error: "invalid_vote" });
          }
          if (!poll.options.some(option => option.id === optionId)) return json(400, { error: "unknown_option" });
          // Only open polls before their deadline accept votes. Drafts and
          // closed/archived polls answer poll_closed; results stay public.
          if (poll.status !== "open" || Date.now() >= Date.parse(poll.closesAt)) {
            observation.decision = "poll_closed";
            return json(409, { error: "poll_closed" });
          }
          // Resolve the immutable snapshot the proof must bind to: either the
          // explicitly requested version, or the version whose Merkle root the
          // proof carries (legacy clients that omit groupVersion). Historical
          // versions conflict; unknown roots are unprocessable.
          let snapshotVersion: number;
          if (groupVersion !== undefined) {
            if (groupVersion !== poll.groupVersion) {
              observation.decision = "group_version_changed";
              return json(409, { error: "group_version_changed" });
            }
            if (proof.merkleTreeRoot !== poll.merkleRoot) return json(422, { error: "proof_binding_mismatch" });
            snapshotVersion = groupVersion as number;
          } else {
            const snapshot = catalog.groupSnapshotByRoot(poll.id, proof.merkleTreeRoot);
            if (!snapshot) return json(422, { error: "unknown_merkle_root" });
            if (snapshot.version !== poll.groupVersion) {
              observation.decision = "group_version_changed";
              return json(409, { error: "group_version_changed" });
            }
            snapshotVersion = snapshot.version;
          }
          // The proof must also be bound to this poll (scope) and the chosen
          // option (message).
          let bound = false;
          try {
            bound = proof.scope === textToField(poll.id) && proof.message === textToField(optionId);
          } catch { bound = false; }
          if (!bound) return json(422, { error: "proof_binding_mismatch" });
          let valid = false;
          proverUsed = true;
          try {
            valid = await verifyProof(proof as unknown as SemaphoreProof);
            // A completed verification proves the engine healthy again and
            // clears any earlier engine failure.
            proofEngine = { status: "ok" };
          } catch {
            valid = false;
            proofEngine = { status: "error", errorCode: "proof_engine_error" };
          }
          if (!valid) return json(422, { error: "invalid_proof" });
          // Snapshot confirmation, freeze-on-first-vote, nullifier dedup and
          // the vote write commit atomically; a concurrent group change makes
          // exactly one of the two succeed. A vote racing closesAt is rejected
          // as the poll is persisted closed in that same transaction.
          const outcome = catalog.commitVote(poll.id, optionId, proof.nullifier, snapshotVersion);
          if (!outcome.ok) {
            if (outcome.reason === "duplicate_nullifier" || outcome.reason === "group_version_changed" || outcome.reason === "poll_closed") {
              observation.decision = outcome.reason;
              return json(409, { error: outcome.reason });
            }
            return json(400, { error: "unknown_option" });
          }
          observation.decision = "accepted";
          return json(201, { receipt: outcome.receipt });
        }
      }
      if (segments[1] === "receipts" && segments.length === 3) {
        observation.operation = "receipt_get";
        if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
        let id: string;
        try { id = decodeURIComponent(segments[2]); }
        catch { return json(400, { error: "invalid_receipt_id" }); }
        const receipt = catalog.receipt(id);
        return receipt ? json(200, { receipt }) : json(404, { error: "receipt_not_found" });
      }
      if (segments[1] === "receipts" && segments.length === 4 && segments[3] === "verify") {
        // A voter proves their ballot was counted by presenting the receipt's
        // own public fields; nothing here links the receipt to an identity.
        observation.operation = "receipt_verify";
        if (method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });
        let id: string;
        try { id = decodeURIComponent(segments[2]); }
        catch { return json(400, { error: "invalid_receipt_id" }); }
        let body: unknown;
        try { body = JSON.parse(await readBody(request)); }
        catch { return json(400, { error: "invalid_json" }); }
        if (typeof body !== "object" || body === null) return json(400, { error: "invalid_verification" });
        const { pollId, optionId, nullifier } = body as Record<string, unknown>;
        if (typeof pollId !== "string" || typeof optionId !== "string" || typeof nullifier !== "string") {
          return json(400, { error: "invalid_verification" });
        }
        const receipt = catalog.receipt(id);
        if (!receipt) return json(404, { error: "receipt_not_found" });
        if (receipt.pollId !== pollId || receipt.optionId !== optionId || receipt.nullifier !== nullifier) {
          return json(422, { error: "receipt_mismatch" });
        }
        return json(200, { valid: true, receipt });
      }
      return json(404, { error: "not_found" });
    } catch {
      // An unexpected failure still answers and logs like any other request.
      observation.errorCode ??= "internal_error";
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      if (!response.writableEnded) response.end(JSON.stringify({ error: "internal_error" }));
    } finally {
      observe(observation, requestId, response.statusCode, startedMs);
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] === "api") return handleApi(request, response, url, segments);
    if (request.method !== "GET") return sendJson(response, 405, { error: "method_not_allowed" }, { Allow: "GET" });
    let relativePath: string;
    try { relativePath = decodeURIComponent(url.pathname); }
    catch { return sendJson(response, 400, { error: "invalid_path" }); }
    const file = resolve(publicPath, relativePath === "/" ? "index.html" : `.${relativePath}`);
    if (!file.startsWith(`${resolve(publicPath)}${sep}`) || !existsSync(file) || !statSync(file).isFile()) return sendJson(response, 404, { error: "not_found" });
    response.writeHead(200, { "Content-Type": mime[extname(file)] ?? "application/octet-stream", "X-Content-Type-Options": "nosniff" });
    response.end(readFileSync(file));
  }
}

function isStatus(value: unknown): value is PollStatus {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

const DEFAULT_AUDIT_PAGE_SIZE = 50;
const MAX_AUDIT_PAGE_SIZE = 200;

type ParseAuditQueryResult =
  | { ok: true; query: AuditQuery }
  | { ok: false; error: string };

/**
 * Validates the audit trail filters. from/to must be strict timezone-aware
 * ISO 8601 instants (values only `Date.parse` tolerates loosely — date-only,
 * space-separated, zone-less, impossible calendar dates — are rejected) and
 * are inclusive at both ends; an inverted range is a 400. pageSize defaults
 * to 50 and is capped at 200.
 */
function parseAuditQuery(params: URLSearchParams): ParseAuditQueryResult {
  const query: AuditQuery = { page: 1, pageSize: DEFAULT_AUDIT_PAGE_SIZE };
  const from = params.get("from");
  const to = params.get("to");
  if (from !== null) {
    const parsed = parseInstant(from);
    if (!parsed) return { ok: false, error: "invalid_time_range" };
    query.from = parsed;
  }
  if (to !== null) {
    const parsed = parseInstant(to);
    if (!parsed) return { ok: false, error: "invalid_time_range" };
    query.to = parsed;
  }
  if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
    return { ok: false, error: "invalid_time_range" };
  }
  const pollId = params.get("pollId");
  if (pollId !== null) query.pollId = pollId;
  const action = params.get("action");
  if (action !== null) query.action = action;
  const result = params.get("result");
  if (result !== null) query.result = result;
  const page = params.get("page");
  if (page !== null) {
    const parsed = Number(page);
    if (!Number.isInteger(parsed) || parsed < 1) return { ok: false, error: "invalid_pagination" };
    query.page = parsed;
  }
  const pageSize = params.get("pageSize");
  if (pageSize !== null) {
    const parsed = Number(pageSize);
    if (!Number.isInteger(parsed) || parsed < 1) return { ok: false, error: "invalid_pagination" };
    query.pageSize = Math.min(parsed, MAX_AUDIT_PAGE_SIZE);
  }
  return { ok: true, query };
}

type ParsePollResult =
  | { ok: true; input: NewPollInput }
  | { ok: false; reason: string; pollId: string };

/**
 * Validates a draft creation payload: all existing poll fields, a non-empty
 * list of distinct member commitments and at least two options with unique
 * ids. Returns a machine-readable error code on failure.
 */
function parseNewPoll(body: unknown): ParsePollResult {
  if (typeof body !== "object" || body === null) return { ok: false, reason: "invalid_poll", pollId: "unknown" };
  const b = body as Record<string, unknown>;
  const pollId = typeof b.id === "string" && b.id.trim() ? b.id : "unknown";
  const fail = (reason: string): ParsePollResult => ({ ok: false, reason, pollId });
  if (!isNonEmptyString(b.id, 128)) return fail("invalid_poll_id");
  if (!isNonEmptyString(b.title)) return fail("invalid_poll");
  if (!isNonEmptyString(b.summary)) return fail("invalid_poll");
  if (!isNonEmptyString(b.description, 20_000)) return fail("invalid_poll");
  if (!isNonEmptyString(b.organizer)) return fail("invalid_poll");
  const publishedAt = parseInstant(b.publishedAt);
  const closesAt = parseInstant(b.closesAt);
  if (!publishedAt || !closesAt) return fail("invalid_poll_dates");
  if (closesAt <= publishedAt) return fail("invalid_poll_dates");
  if (!Array.isArray(b.options) || b.options.length < 2) return fail("invalid_options");
  const optionIds = new Set<string>();
  const options: { id: string; label: string }[] = [];
  for (const option of b.options) {
    if (typeof option !== "object" || option === null) return fail("invalid_options");
    const { id, label } = option as { id?: unknown; label?: unknown };
    if (!isNonEmptyString(id, 128) || !isNonEmptyString(label)) return fail("invalid_options");
    if (optionIds.has(id)) return fail("duplicate_option_id");
    optionIds.add(id);
    options.push({ id, label });
  }
  if (!Array.isArray(b.commitments) || b.commitments.length === 0) return fail("invalid_commitments");
  const commitments: string[] = [];
  for (const commitment of b.commitments) {
    if (!isCommitment(commitment)) return fail("invalid_commitments");
    if (commitments.includes(commitment)) return fail("duplicate_commitment");
    commitments.push(commitment);
  }
  return {
    ok: true,
    input: {
      id: b.id, title: b.title, summary: b.summary, description: b.description, organizer: b.organizer,
      publishedAt, closesAt,
      options, commitments
    }
  };
}

export type { AuditEvent };
