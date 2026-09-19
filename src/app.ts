import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { verifyProof, type SemaphoreProof } from "@semaphore-protocol/proof";
import { openCatalog, STATUSES, type GroupOperation, type NewPollInput } from "./store.ts";
import { isCommitment, isProofPayload, terminateProverWorkers, textToField } from "./voting.ts";
import type { AuditEvent, PollStatus } from "./types.ts";

const MAX_BODY_BYTES = 1_000_000;

export interface AppOptions {
  /** When unset (or empty) every administrative request is refused with 401. */
  adminToken?: string;
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
function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function createApp(databasePath: string, publicPath = resolve("dist/public"), options: AppOptions = {}) {
  const catalog = openCatalog(databasePath);
  const adminToken = options.adminToken && options.adminToken.length > 0 ? options.adminToken : undefined;
  let proverUsed = false;
  const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8" };
  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
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

  async function handle(request: IncomingMessage, response: ServerResponse) {
    function json(status: number, payload: unknown, headers: Record<string, string> = {}) {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
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
      const method = request.method ?? "GET";
      if (url.pathname === "/api/health") {
        if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
        return json(200, { service: "veilvote", status: "ok" });
      }
      if (segments[1] === "admin" && segments[2] === "audit" && segments.length === 3) {
        if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
        if (!requireAdmin()) return;
        return json(200, { events: catalog.auditEvents() });
      }
      if (segments[1] === "polls" && segments.length <= 4) {
        if (segments.length === 2) {
          // Public catalog list; creating a poll is admin-only and starts in draft.
          if (method === "GET") return json(200, { polls: catalog.list(Date.now(), isAuthorized(request)) });
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
          if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
          const poll = catalog.get(id);
          // Drafts are invisible to ordinary detail requests; an authorized
          // manager can still read them to prepare the opening.
          if (!poll || (poll.status === "draft" && !isAuthorized(request))) return json(404, { error: "poll_not_found" });
          return json(200, { poll });
        }
        if (segments[3] === "results") {
          if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
          const result = catalog.results(id);
          return result ? json(200, { result }) : json(404, { error: "poll_not_found" });
        }
        if (segments[3] === "status") {
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
          try { valid = await verifyProof(proof as unknown as SemaphoreProof); }
          catch { valid = false; }
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
        if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
        let id: string;
        try { id = decodeURIComponent(segments[2]); }
        catch { return json(400, { error: "invalid_receipt_id" }); }
        const receipt = catalog.receipt(id);
        return receipt ? json(200, { receipt }) : json(404, { error: "receipt_not_found" });
      }
      return json(404, { error: "not_found" });
    }
    if (request.method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
    let relativePath: string;
    try { relativePath = decodeURIComponent(url.pathname); }
    catch { return json(400, { error: "invalid_path" }); }
    const file = resolve(publicPath, relativePath === "/" ? "index.html" : `.${relativePath}`);
    if (!file.startsWith(`${resolve(publicPath)}${sep}`) || !existsSync(file) || !statSync(file).isFile()) return json(404, { error: "not_found" });
    response.writeHead(200, { "Content-Type": mime[extname(file)] ?? "application/octet-stream", "X-Content-Type-Options": "nosniff" });
    response.end(readFileSync(file));
  }
}

function isStatus(value: unknown): value is PollStatus {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
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
  if (!isIsoDate(b.publishedAt) || !isIsoDate(b.closesAt)) return fail("invalid_poll_dates");
  if (Date.parse(b.closesAt as string) <= Date.parse(b.publishedAt as string)) return fail("invalid_poll_dates");
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
      publishedAt: new Date(b.publishedAt).toISOString(), closesAt: new Date(b.closesAt).toISOString(),
      options, commitments
    }
  };
}

export type { AuditEvent };
