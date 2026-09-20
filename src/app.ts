import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { verifyProof, type SemaphoreProof } from "@semaphore-protocol/proof";
import { openCatalog, STATUSES, type AuditQuery, type GroupOperation, type NewPollInput } from "./store.ts";
import { isCommitment, isProofPayload, terminateProverWorkers, textToField } from "./voting.ts";
import { parseInstant } from "./time.ts";
import {
  MetricsRegistry, decisionFor, emitRequestLog, newObsContext, newRequestId, outcomeFor, sanitizeErrorCode,
  type ObsContext, type RequestLogEntry
} from "./observability.ts";
import type { AuditEvent, PollStatus } from "./types.ts";

const MAX_BODY_BYTES = 1_000_000;

export interface AppOptions {
  /** When unset (or empty) every administrative request is refused with 401. */
  adminToken?: string;
  /** Sink for single-line JSON access logs; defaults to stdout. A throwing sink is swallowed. */
  logSink?: (line: string) => void;
  /** Proof verification implementation; defaults to the Semaphore verifier. */
  verifyProofImpl?: (proof: SemaphoreProof) => Promise<boolean>;
  /** SQLite readiness probe; defaults to a SELECT 1 against the catalog. */
  sqlitePing?: () => void;
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

export function createApp(databasePath: string, publicPath = resolve("dist/public"), options: AppOptions = {}) {
  const catalog = openCatalog(databasePath);
  const adminToken = options.adminToken && options.adminToken.length > 0 ? options.adminToken : undefined;
  const logSink = options.logSink ?? ((line: string) => process.stdout.write(line));
  const verify = options.verifyProofImpl ?? verifyProof;
  const sqlitePing = options.sqlitePing ?? (() => catalog.ping());
  const metrics = new MetricsRegistry();
  // The proof engine starts healthy; its first verification proves it. A
  // verification failure latches an error that /api/ready reports until a
  // later verification succeeds and clears it.
  let proverFailure = false;
  let proverUsed = false;
  const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8" };
  const server = createServer((request, response) => {
    // Server-generated for every request; a client-supplied X-Request-Id is
    // never read, so it can neither spoof nor correlate logs.
    const requestId = newRequestId();
    const startedAt = new Date();
    const startedNs = process.hrtime.bigint();
    const obs = newObsContext();
    response.on("finish", () => finishObservation(obs, requestId, startedAt, startedNs));
    handle(request, response, obs, requestId).catch(() => {
      obs.statusCode = obs.statusCode > 0 ? obs.statusCode : 500;
      obs.errorCode = obs.errorCode ?? "internal_error";
      if (!response.headersSent) {
        response.writeHead(500, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          ...(obs.header ? { "X-Request-Id": requestId } : {})
        });
      }
      response.end(JSON.stringify({ error: "internal_error" }));
    });
  });
  server.on("close", () => {
    catalog.close();
    // Release the snarkjs worker pool so the process can exit.
    if (proverUsed) void terminateProverWorkers();
  });
  return server;

  /**
   * Writes the single-line JSON access record and updates in-memory metrics
   * once the response has actually been flushed. Runs on the response "finish"
   * event, so every terminal status — success, rejection, unauthorized and
   * internal error — is observed exactly once. Failures here never touch the
   * already-sent business response.
   */
  function finishObservation(obs: ObsContext, requestId: string, startedAt: Date, startedNs: bigint) {
    if (obs.skip) return;
    const statusCode = obs.statusCode > 0 ? obs.statusCode : 500;
    const outcome = outcomeFor(statusCode);
    const entry: RequestLogEntry = {
      at: startedAt.toISOString(),
      requestId,
      operation: obs.operation,
      statusCode,
      outcome,
      durationMs: Number((process.hrtime.bigint() - startedNs) / 1_000_000n)
    };
    if (statusCode >= 400) entry.errorCode = obs.errorCode ?? (statusCode >= 500 ? "internal_error" : undefined);
    const decision = decisionFor(obs.operation, statusCode, outcome);
    if (decision !== undefined) entry.decision = decision;
    emitRequestLog(logSink, entry);
    try { metrics.record(entry); } catch { /* metrics must never break a response */ }
  }

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

  async function handle(request: IncomingMessage, response: ServerResponse, obs: ObsContext, requestId: string) {
    function json(status: number, payload: unknown, headers: Record<string, string> = {}) {
      obs.statusCode = status;
      if (typeof payload === "object" && payload !== null && "error" in payload) {
        const code = sanitizeErrorCode((payload as { error: unknown }).error);
        if (code) obs.errorCode = code;
      }
      // Every API answer carries the server-generated id; X-Request-Id from
      // the client is ignored entirely (never echoed, never trusted). skip
      // (metrics endpoint) suppresses only the log/metrics record, not the
      // header; non-API static assets get neither.
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...(obs.header ? { "X-Request-Id": requestId } : {}),
        ...headers
      });
      response.end(JSON.stringify(payload));
    }
    function requireAdmin(): boolean {
      if (isAuthorized(request)) return true;
      json(401, { error: "admin_unauthorized" });
      return false;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] === "api") {
      obs.skip = false;
      obs.header = true;
      const method = request.method ?? "GET";
      if (url.pathname === "/api/health") {
        obs.operation = "health";
        if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
        return json(200, { service: "veilvote", status: "ok" });
      }
      // Readiness probes the real dependencies, not just the event loop.
      if (url.pathname === "/api/ready") {
        obs.operation = "ready";
        if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
        const checks = readinessChecks();
        // idle (proof engine not used yet) and ok are both healthy; only error fails readiness.
        const healthy = checks.every(check => check.status !== "error");
        return json(healthy ? 200 : 503, {
          service: "veilvote",
          status: healthy ? "ready" : "not_ready",
          checks
        });
      }
      if (segments[1] === "admin" && segments[2] === "metrics" && segments.length === 3) {
        // Traffic to the metrics endpoint is never itself observed (200, 401
        // or 405); answers still carry the server-generated correlation id.
        obs.operation = "metrics";
        obs.skip = true;
        if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
        if (!isAuthorized(request)) {
          response.writeHead(401, {
            "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Request-Id": requestId
          });
          response.end(JSON.stringify({ error: "admin_unauthorized" }));
          return;
        }
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Request-Id": requestId
        });
        response.end(JSON.stringify(metrics.snapshot()));
        return;
      }
      if (segments[1] === "admin" && segments[2] === "audit" && segments.length === 3) {
        obs.operation = "audit_query";
        if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
        if (!requireAdmin()) return;
        const query = parseAuditQuery(url.searchParams);
        if (!query.ok) return json(400, { error: query.error });
        return json(200, catalog.auditQuery(query.query));
      }
      if (segments[1] === "polls" && segments.length <= 4) {
        if (segments.length === 2) {
          // Public catalog list; creating a poll is admin-only and starts in draft.
          if (method === "GET") {
            obs.operation = "poll_list";
            return json(200, { polls: catalog.list(Date.now(), isAuthorized(request)) });
          }
          obs.operation = "poll_create";
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
        // Default for the detail route; results/status/group/votes overwrite it.
        obs.operation = "poll_detail";
        try { id = decodeURIComponent(segments[2]); }
        catch { return json(400, { error: "invalid_poll_id" }); }
        if (segments.length === 3) {
          if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
          const poll = catalog.get(id);
          // Drafts are invisible to ordinary detail requests; an authorized
          // manager can still read them to prepare the opening.
          if (!poll || (poll.status === "draft" && !isAuthorized(request))) return json(404, { error: "poll_not_found" });
          return json(200, { poll });
        }
        if (segments[3] === "results") {
          obs.operation = "poll_results";
          if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
          const result = catalog.results(id);
          return result ? json(200, { result }) : json(404, { error: "poll_not_found" });
        }
        if (segments[3] === "status") {
          obs.operation = "status_change";
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
          obs.operation = "group_change";
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
            if (outcome.reason === "poll_missing") return json(404, { error: "poll_not_found" });
            if (outcome.reason === "group_frozen" || outcome.reason === "group_version_changed" || outcome.reason === "poll_not_editable") return json(409, { error: outcome.reason });
            return json(400, { error: outcome.reason });
          }
          return json(201, { group: outcome.group });
        }
        if (segments[3] === "votes") {
          obs.operation = "vote_submit";
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
          if (poll.status !== "open" || Date.now() >= Date.parse(poll.closesAt)) return json(409, { error: "poll_closed" });
          // Resolve the immutable snapshot the proof must bind to: either the
          // explicitly requested version, or the version whose Merkle root the
          // proof carries (legacy clients that omit groupVersion). Historical
          // versions conflict; unknown roots are unprocessable.
          let snapshotVersion: number;
          if (groupVersion !== undefined) {
            if (groupVersion !== poll.groupVersion) return json(409, { error: "group_version_changed" });
            if (proof.merkleTreeRoot !== poll.merkleRoot) return json(422, { error: "proof_binding_mismatch" });
            snapshotVersion = groupVersion as number;
          } else {
            const snapshot = catalog.groupSnapshotByRoot(poll.id, proof.merkleTreeRoot);
            if (!snapshot) return json(422, { error: "unknown_merkle_root" });
            if (snapshot.version !== poll.groupVersion) return json(409, { error: "group_version_changed" });
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
            valid = await verify(proof as unknown as SemaphoreProof);
            // A successful verification proves the engine is working again and
            // clears a failure latched by an earlier broken verification run.
            proverFailure = false;
          } catch {
            valid = false;
            proverFailure = true;
          }
          if (!valid) return json(422, { error: "invalid_proof" });
          // Snapshot confirmation, freeze-on-first-vote, nullifier dedup and
          // the vote write commit atomically; a concurrent group change makes
          // exactly one of the two succeed. A vote racing closesAt is rejected
          // as the poll is persisted closed in that same transaction.
          const outcome = catalog.commitVote(poll.id, optionId, proof.nullifier, snapshotVersion);
          if (!outcome.ok) {
            if (outcome.reason === "duplicate_nullifier") return json(409, { error: "duplicate_nullifier" });
            if (outcome.reason === "group_version_changed") return json(409, { error: "group_version_changed" });
            if (outcome.reason === "poll_closed") return json(409, { error: "poll_closed" });
            return json(400, { error: "unknown_option" });
          }
          return json(201, { receipt: outcome.receipt });
        }
      }
      if (segments[1] === "receipts" && segments.length === 3) {
        obs.operation = "receipt_lookup";
        if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
        let id: string;
        try { id = decodeURIComponent(segments[2]); }
        catch { return json(400, { error: "invalid_receipt_id" }); }
        const receipt = catalog.receipt(id);
        return receipt ? json(200, { receipt }) : json(404, { error: "receipt_not_found" });
      }
      if (segments[1] === "receipts" && segments.length === 4 && segments[3] === "verify") {
        obs.operation = "receipt_verify";
        // A voter proves their ballot was counted by presenting the receipt's
        // own public fields; nothing here links the receipt to an identity.
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
      obs.operation = "not_found";
      return json(404, { error: "not_found" });
    }
    obs.operation = "static";
    if (request.method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
    let relativePath: string;
    try { relativePath = decodeURIComponent(url.pathname); }
    catch { return json(400, { error: "invalid_path" }); }
    const file = resolve(publicPath, relativePath === "/" ? "index.html" : `.${relativePath}`);
    if (!file.startsWith(`${resolve(publicPath)}${sep}`) || !existsSync(file) || !statSync(file).isFile()) return json(404, { error: "not_found" });
    response.writeHead(200, {
      "Content-Type": mime[extname(file)] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(readFileSync(file));
  }

  /**
   * Dependency readiness. Each check reports only a stable name, one of
   * idle/ok/error and a stable error code — never a path or stack trace. The
   * proof engine is idle until its first verification, and an error latches
   * until a later verification succeeds.
   */
  function readinessChecks(): { name: string; status: "idle" | "ok" | "error"; errorCode?: string }[] {
    let sqlite: { name: string; status: "idle" | "ok" | "error"; errorCode?: string };
    try {
      sqlitePing();
      sqlite = { name: "sqlite", status: "ok" };
    } catch {
      sqlite = { name: "sqlite", status: "error", errorCode: "sqlite_unavailable" };
    }
    const proof = proverFailure
      ? { name: "proof_engine", status: "error" as const, errorCode: "proof_engine_failure" }
      : { name: "proof_engine", status: proverUsed ? "ok" as const : "idle" as const };
    return [sqlite, proof];
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
