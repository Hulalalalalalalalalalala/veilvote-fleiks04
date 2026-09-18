import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { verifyProof, type SemaphoreProof } from "@semaphore-protocol/proof";
import { openCatalog } from "./store.ts";
import { isProofPayload, terminateProverWorkers, textToField } from "./voting.ts";
import type { GroupOperation } from "./types.ts";

const MAX_BODY_BYTES = 1_000_000;
// BN254 scalar field order: commitments must be non-zero field elements.
const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const COMMITMENT_PATTERN = /^[1-9]\d*$/;

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

function isCommitment(value: unknown): value is string {
  return typeof value === "string" && COMMITMENT_PATTERN.test(value) && BigInt(value) < FIELD_SIZE;
}

export function createApp(databasePath: string, publicPath = resolve("dist/public")) {
  const catalog = openCatalog(databasePath);
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
      if (segments[1] === "polls" && segments.length <= 4) {
        if (segments.length === 2) {
          if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
          return json(200, { polls: catalog.list() });
        }
        let id: string;
        try { id = decodeURIComponent(segments[2]); }
        catch { return json(400, { error: "invalid_poll_id" }); }
        if (segments.length === 3) {
          if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
          const poll = catalog.get(id);
          return poll ? json(200, { poll }) : json(404, { error: "poll_not_found" });
        }
        if (segments[3] === "results") {
          if (method !== "GET") return json(405, { error: "method_not_allowed" }, { Allow: "GET" });
          const result = catalog.results(id);
          return result ? json(200, { result }) : json(404, { error: "poll_not_found" });
        }
        if (segments[3] === "group") {
          if (method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });
          return handleGroupChange(id);
        }
        if (segments[3] === "votes") {
          if (method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });
          return handleVote(id);
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

    async function handleGroupChange(pollId: string) {
      const poll = catalog.get(pollId);
      if (!poll) return json(404, { error: "poll_not_found" });
      let body: unknown;
      try { body = JSON.parse(await readBody(request)); }
      catch { return json(400, { error: "invalid_json" }); }
      if (typeof body !== "object" || body === null) return json(400, { error: "invalid_group_change" });
      const { operation, expectedVersion, commitment, oldCommitment, newCommitment } = body as {
        operation?: unknown; expectedVersion?: unknown; commitment?: unknown; oldCommitment?: unknown; newCommitment?: unknown;
      };
      if (operation !== "join" && operation !== "rotate" && operation !== "revoke") return json(400, { error: "invalid_group_change" });
      if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1) return json(400, { error: "invalid_group_change" });
      let params: { commitment?: string; oldCommitment?: string; newCommitment?: string };
      if (operation === "join") {
        if (!isCommitment(commitment)) return json(400, { error: "invalid_group_change" });
        params = { commitment };
      } else if (operation === "rotate") {
        if (!isCommitment(oldCommitment) || !isCommitment(newCommitment)) return json(400, { error: "invalid_group_change" });
        params = { oldCommitment, newCommitment };
      } else {
        if (!isCommitment(commitment)) return json(400, { error: "invalid_group_change" });
        params = { commitment };
      }
      const outcome = catalog.applyGroupChange(pollId, operation as GroupOperation, expectedVersion as number, params);
      if (!outcome.ok) {
        switch (outcome.reason) {
          case "poll_not_found": return json(404, { error: "poll_not_found" });
          case "group_frozen":
            return json(409, { error: "group_frozen", groupVersion: poll.groupVersion, merkleRoot: poll.merkleRoot });
          case "version_conflict": {
            const current = catalog.get(pollId)!;
            return json(409, { error: "group_version_changed", groupVersion: current.groupVersion, merkleRoot: current.merkleRoot });
          }
          case "commitment_not_found": return json(400, { error: "commitment_not_found" });
          case "duplicate_commitment": return json(400, { error: "duplicate_commitment" });
          case "empty_group": return json(400, { error: "empty_group" });
          case "poll_closed": return json(409, { error: "poll_closed" });
        }
      }
      return json(201, { group: outcome.summary });
    }

    async function handleVote(pollId: string) {
      const poll = catalog.get(pollId);
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
      if (poll.status !== "open" || Date.now() >= Date.parse(poll.closesAt)) return json(409, { error: "poll_closed" });
      // The proof must be bound to this poll (scope) and the chosen option
      // (message); the Merkle root is checked against the stored snapshots.
      let bound = false;
      try {
        bound = proof.scope === textToField(poll.id) && proof.message === textToField(optionId);
      } catch { bound = false; }
      if (!bound) return json(422, { error: "proof_binding_mismatch" });
      if (groupVersion !== undefined) {
        // New clients pin the snapshot they proved against. A superseded (or
        // future) version is a refreshable conflict; a wrong root at the
        // current version is a rejected proof.
        if ((groupVersion as number) !== poll.groupVersion) {
          return json(409, { error: "group_version_changed", groupVersion: poll.groupVersion, merkleRoot: poll.merkleRoot });
        }
        if (proof.merkleTreeRoot !== poll.merkleRoot) return json(422, { error: "proof_binding_mismatch" });
      } else {
        // Legacy clients send no version: resolve the proof root to a snapshot.
        const snapshot = catalog.snapshotByRoot(poll.id, proof.merkleTreeRoot);
        if (!snapshot) return json(422, { error: "proof_binding_mismatch" });
        if (!snapshot.current) {
          return json(409, { error: "group_version_changed", groupVersion: poll.groupVersion, merkleRoot: poll.merkleRoot });
        }
      }
      let valid = false;
      proverUsed = true;
      try { valid = await verifyProof(proof as unknown as SemaphoreProof); }
      catch { valid = false; }
      if (!valid) return json(422, { error: "invalid_proof" });
      // Snapshot confirmation, freeze, nullifier dedup and insertion happen
      // atomically here, so a concurrent group change can never interleave.
      const outcome = catalog.commitVote(poll.id, optionId, proof.nullifier, proof.merkleTreeRoot);
      if (!outcome.ok) {
        if (outcome.reason === "duplicate_nullifier") return json(409, { error: "duplicate_nullifier" });
        if (outcome.reason === "poll_closed") return json(409, { error: "poll_closed" });
        if (outcome.reason === "historical_version") {
          const current = catalog.get(pollId)!;
          return json(409, { error: "group_version_changed", groupVersion: current.groupVersion, merkleRoot: current.merkleRoot });
        }
        if (outcome.reason === "unknown_root") return json(422, { error: "proof_binding_mismatch" });
        return json(400, { error: "unknown_option" });
      }
      return json(201, { receipt: outcome.receipt });
    }
  }
}
