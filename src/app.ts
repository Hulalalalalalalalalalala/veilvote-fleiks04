import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { verifyProof, type SemaphoreProof } from "@semaphore-protocol/proof";
import { openCatalog, type GroupOperation } from "./store.ts";
import { isCommitment, isProofPayload, terminateProverWorkers, textToField } from "./voting.ts";
import type { PollStatus } from "./types.ts";

const MAX_BODY_BYTES = 1_000_000;
const STATUSES: PollStatus[] = ["draft", "open", "closed", "archived"];
// Next legal statuses, mirrored from the store's authoritative table for UI hints.
const LEGAL_TRANSITIONS: Record<PollStatus, PollStatus[]> = {
  draft: ["open"],
  open: ["closed"],
  closed: ["archived"],
  archived: []
};

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
function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function createApp(databasePath: string, publicPath = resolve("dist/public"), adminToken?: string) {
  const catalog = openCatalog(databasePath);
  const configuredAdminToken = adminToken && adminToken.length > 0 ? adminToken : undefined;
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
   * Admin requests carry X-Admin-Token. A missing header, a wrong token, or a
   * service with no ADMIN_TOKEN configured are all 401 admin_unauthorized,
   * and the check runs before any body is parsed or any row written, so an
   * unauthorized request can never mutate data (the audit log included).
   */
  function isAdmin(request: IncomingMessage): boolean {
    if (!configuredAdminToken) return false;
    const provided = request.headers["x-admin-token"];
    if (typeof provided !== "string") return false;
    const expected = Buffer.from(configuredAdminToken);
    const actual = Buffer.from(provided);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
  function requireAdmin(request: IncomingMessage, response: ServerResponse): boolean {
    if (isAdmin(request)) return true;
    response.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ error: "admin_unauthorized" }));
    return false;
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    function json(status: number, payload: unknown, headers: Record<string, string> = {}) {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
      response.end(JSON.stringify(payload));
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] === "api") {
      const method = request.method ?? "GET";
      if (url.pathname === "/api/health") {
        if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
        return json(200, { service: "veilvote", status: "ok" });
      }
      if (url.pathname === "/api/admin/audit") {
        if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
        if (!requireAdmin(request, response)) return;
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam === null ? 100 : Number(limitParam);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) return json(400, { error: "invalid_limit" });
        return json(200, { events: catalog.audit(limit) });
      }
      if (segments[1] === "admin" && segments[2] === "polls" && segments.length === 3) {
        if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
        if (!requireAdmin(request, response)) return;
        return json(200, { polls: catalog.listAll(), legalTransitions: LEGAL_TRANSITIONS });
      }
      if (segments[1] === "polls" && segments.length <= 4) {
        if (segments.length === 2) {
          if (method === "GET") return json(200, { polls: catalog.list() });
          if (method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "GET, POST" });
          if (!requireAdmin(request, response)) return;
          let body: unknown;
          try { body = JSON.parse(await readBody(request)); }
          catch {
            catalog.recordAuditEvent("poll_created", null, "failure", { reason: "invalid_json" });
            return json(400, { error: "invalid_json" });
          }
          const draft = parseDraftBody(body);
          if (!draft.ok) {
            const subject = typeof body === "object" && body !== null && nonEmptyString((body as Record<string, unknown>).id)
              ? ((body as Record<string, unknown>).id as string)
              : null;
            // Business failure on an authorized request still leaves an event;
            // only non-sensitive validation metadata is recorded.
            catalog.recordAuditEvent("poll_created", subject, "failure", { reason: draft.reason, fields: draft.fields });
            return json(400, { error: draft.reason, fields: draft.fields });
          }
          const outcome = catalog.createDraft(draft.input);
          if (!outcome.ok) return json(409, { error: "poll_exists" });
          return json(201, { poll: outcome.poll });
        }
        let id: string;
        try { id = decodeURIComponent(segments[2]); }
        catch { return json(400, { error: "invalid_poll_id" }); }
        if (segments.length === 3) {
          if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
          const poll = catalog.get(id) ?? (isAdmin(request) ? catalog.getForAdmin(id) : undefined);
          return poll ? json(200, { poll }) : json(404, { error: "poll_not_found" });
        }
        if (segments[3] === "results") {
          if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
          const result = catalog.results(id);
          return result ? json(200, { result }) : json(404, { error: "poll_not_found" });
        }
        if (segments[3] === "status") {
          if (method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });
          if (!requireAdmin(request, response)) return;
          let body: unknown;
          try { body = JSON.parse(await readBody(request)); }
          catch {
            catalog.recordAuditEvent("status_changed", id, "failure", { reason: "invalid_json" });
            return json(400, { error: "invalid_json" });
          }
          if (typeof body !== "object" || body === null) {
            catalog.recordAuditEvent("status_changed", id, "failure", { reason: "invalid_status" });
            return json(400, { error: "invalid_status" });
          }
          const { status, expectedStatus } = body as { status?: unknown; expectedStatus?: unknown };
          if (typeof status !== "string" || !STATUSES.includes(status as PollStatus)) {
            catalog.recordAuditEvent("status_changed", id, "failure", { reason: "invalid_status", status: typeof status === "string" ? status : null });
            return json(400, { error: "invalid_status" });
          }
          let expected: PollStatus | undefined;
          if (expectedStatus !== undefined) {
            if (typeof expectedStatus !== "string" || !STATUSES.includes(expectedStatus as PollStatus)) {
              catalog.recordAuditEvent("status_changed", id, "failure", { reason: "invalid_status", to: status, expectedStatus: typeof expectedStatus === "string" ? expectedStatus : null });
              return json(400, { error: "invalid_status" });
            }
            expected = expectedStatus as PollStatus;
          }
          const outcome = catalog.changeStatus(id, status as PollStatus, expected);
          if (!outcome.ok) {
            if (outcome.reason === "poll_missing") return json(404, { error: "poll_not_found" });
            if (outcome.reason === "illegal_transition") return json(409, { error: "invalid_status_transition" });
            return json(409, { error: "status_conflict" });
          }
          return json(200, { poll: outcome.poll });
        }
        if (segments[3] === "group") {
          if (method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });
          if (!requireAdmin(request, response)) return;
          // Admins may edit drafts too; the store adjudicates status and freeze.
          if (!catalog.getForAdmin(id)) {
            catalog.recordAuditEvent("members_changed", id, "failure", { reason: "poll_missing" });
            return json(404, { error: "poll_not_found" });
          }
          let body: unknown;
          try { body = JSON.parse(await readBody(request)); }
          catch {
            catalog.recordAuditEvent("members_changed", id, "failure", { reason: "invalid_json" });
            return json(400, { error: "invalid_json" });
          }
          if (typeof body !== "object" || body === null) {
            catalog.recordAuditEvent("members_changed", id, "failure", { reason: "invalid_group_operation" });
            return json(400, { error: "invalid_group_operation" });
          }
          const { operation, expectedVersion, commitment, oldCommitment, newCommitment } = body as Record<string, unknown>;
          if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1) {
            catalog.recordAuditEvent("members_changed", id, "failure", { reason: "invalid_group_operation" });
            return json(400, { error: "invalid_group_operation" });
          }
          let groupOperation: GroupOperation;
          if (operation === "join" && isCommitment(commitment)) groupOperation = { type: "join", commitment };
          else if (operation === "rotate" && isCommitment(oldCommitment) && isCommitment(newCommitment)) groupOperation = { type: "rotate", oldCommitment, newCommitment };
          else if (operation === "revoke" && isCommitment(commitment)) groupOperation = { type: "revoke", commitment };
          else {
            catalog.recordAuditEvent("members_changed", id, "failure", { reason: "invalid_group_operation", operation: typeof operation === "string" ? operation : null });
            return json(400, { error: "invalid_group_operation" });
          }
          const outcome = catalog.applyGroupOperation(id, groupOperation, expectedVersion as number);
          if (!outcome.ok) {
            if (outcome.reason === "poll_missing") return json(404, { error: "poll_not_found" });
            if (outcome.reason === "poll_not_editable") return json(409, { error: "poll_not_editable" });
            if (outcome.reason === "group_frozen" || outcome.reason === "group_version_changed") return json(409, { error: outcome.reason });
            return json(400, { error: outcome.reason });
          }
          return json(201, { group: outcome.group });
        }
        if (segments[3] === "votes") {
          if (method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });
          const poll = catalog.get(id);
          if (!poll) return json(404, { error: "poll_not_found" });
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
          // The detail read above already persisted a deadline close, but the
          // transaction in commitVote is the final, authoritative check.
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
          // Snapshot confirmation, deadline close, freeze-on-first-vote,
          // nullifier dedup and the vote write commit atomically; a concurrent
          // group change makes exactly one of the two succeed. Accepted votes
          // and transactionally rejected attempts are audited inside the store.
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
        let receiptId: string;
        try { receiptId = decodeURIComponent(segments[2]); }
        catch { return json(400, { error: "invalid_receipt_id" }); }
        const receipt = catalog.receipt(receiptId);
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

  /**
   * Validates a draft body: existing poll fields, a non-empty commitment list
   * without duplicates, and at least two options with unique non-empty ids.
   * Commitments are never echoed back in error details.
   */
  function parseDraftBody(body: unknown):
    | { ok: true; input: {
        id: string; title: string; summary: string; description: string; organizer: string;
        publishedAt: string; closesAt: string; options: { id: string; label: string }[]; commitments: string[];
      } }
    | { ok: false; reason: "invalid_poll"; fields: string[] } {
    const fields: string[] = [];
    if (typeof body !== "object" || body === null) return { ok: false, reason: "invalid_poll", fields: ["body"] };
    const candidate = body as Record<string, unknown>;
    for (const key of ["id", "title", "summary", "description", "organizer", "publishedAt", "closesAt"]) {
      if (!nonEmptyString(candidate[key])) fields.push(key);
    }
    const publishedAt = parseTimestamp(candidate.publishedAt);
    const closesAt = parseTimestamp(candidate.closesAt);
    if (publishedAt === undefined) fields.push("publishedAt");
    if (closesAt === undefined) fields.push("closesAt");
    if (publishedAt !== undefined && closesAt !== undefined && closesAt <= publishedAt) fields.push("closesAt");
    const options = Array.isArray(candidate.options) ? candidate.options : [];
    if (options.length < 2) fields.push("options");
    const normalizedOptions: { id: string; label: string }[] = [];
    const optionIds = new Set<string>();
    for (const option of options) {
      if (typeof option !== "object" || option === null || !nonEmptyString((option as Record<string, unknown>).id) || !nonEmptyString((option as Record<string, unknown>).label)) {
        fields.push("options");
        break;
      }
      const entry = option as { id: string; label: string };
      if (optionIds.has(entry.id)) { fields.push("options"); break; }
      optionIds.add(entry.id);
      normalizedOptions.push({ id: entry.id, label: entry.label });
    }
    const commitments = Array.isArray(candidate.commitments) ? candidate.commitments : [];
    if (commitments.length === 0) fields.push("commitments");
    const normalizedCommitments: string[] = [];
    const seenCommitments = new Set<string>();
    for (const commitment of commitments) {
      if (!isCommitment(commitment) || seenCommitments.has(commitment)) { fields.push("commitments"); break; }
      seenCommitments.add(commitment);
      normalizedCommitments.push(commitment);
    }
    if (fields.length > 0) return { ok: false, reason: "invalid_poll", fields: [...new Set(fields)] };
    return {
      ok: true,
      input: {
        id: candidate.id as string,
        title: candidate.title as string,
        summary: candidate.summary as string,
        description: candidate.description as string,
        organizer: candidate.organizer as string,
        publishedAt: new Date(publishedAt as number).toISOString(),
        closesAt: new Date(closesAt as number).toISOString(),
        options: normalizedOptions,
        commitments: normalizedCommitments
      }
    };
  }
}
