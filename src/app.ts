import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Group } from "@semaphore-protocol/group";
import { verifyProof } from "@semaphore-protocol/proof";
import { encodeBytes32String, toBigInt } from "ethers";
import { openCatalog } from "./store.ts";

const MAX_BODY_BYTES = 64 * 1024;

interface SubmittedProof {
  merkleTreeDepth: number;
  merkleTreeRoot: string;
  nullifier: string;
  message: string;
  scope: string;
  points: [string, string, string, string, string, string, string, string];
}

// Mirrors @semaphore-protocol/proof's toBigInt: numeric values pass through,
// anything else is encoded as a bytes32 string before hashing in the circuit.
function encodeVoteValue(value: string): string {
  try { return toBigInt(value).toString(); }
  catch { return toBigInt(encodeBytes32String(value)).toString(); }
}

function isProofShape(value: unknown): value is SubmittedProof {
  if (!value || typeof value !== "object") return false;
  const proof = value as Record<string, unknown>;
  return Number.isInteger(proof.merkleTreeDepth)
    && typeof proof.merkleTreeRoot === "string"
    && typeof proof.nullifier === "string"
    && typeof proof.message === "string"
    && typeof proof.scope === "string"
    && Array.isArray(proof.points) && proof.points.length === 8
    && proof.points.every(point => typeof point === "string");
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { rejectPromise(new Error("payload_too_large")); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    request.on("error", rejectPromise);
  });
}

export function createApp(databasePath: string, publicPath = resolve("dist/public")) {
  const catalog = openCatalog(databasePath);
  const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8" };
  const server = createServer((request, response) => {
    function json(status: number, payload: unknown) {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify(payload));
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    function decodeSegment(segment: string): string | undefined {
      try { return decodeURIComponent(segment); }
      catch { return undefined; }
    }
    async function handleVote(encodedId: string) {
      const id = decodeSegment(encodedId);
      if (id === undefined) { request.resume(); return json(400, { error: "invalid_poll_id" }); }
      const poll = catalog.get(id);
      if (!poll) { request.resume(); return json(404, { error: "poll_not_found" }); }
      let payload: unknown;
      try { payload = JSON.parse(await readBody(request)); }
      catch { return json(400, { error: "invalid_request" }); }
      if (!payload || typeof payload !== "object") return json(400, { error: "invalid_request" });
      const { optionId, proof } = payload as { optionId?: unknown; proof?: unknown };
      if (typeof optionId !== "string" || optionId.length === 0 || !isProofShape(proof)) {
        return json(400, { error: "invalid_request" });
      }
      if (!poll.options.some(option => option.id === optionId)) return json(400, { error: "invalid_option" });
      const now = new Date();
      if (poll.status !== "open" || now.getTime() > Date.parse(poll.closesAt)) return json(409, { error: "poll_closed" });
      // The proof must bind this exact option as message and this poll as scope,
      // and its root must match the group rebuilt from the stored commitments.
      const group = new Group(poll.eligibleMemberCommitments);
      const bound =
        proof.message === encodeVoteValue(optionId) &&
        proof.scope === encodeVoteValue(poll.id) &&
        proof.merkleTreeRoot === group.root.toString();
      let valid = false;
      if (bound) {
        try { valid = await verifyProof(proof); }
        catch { valid = false; }
      }
      if (!valid) return json(422, { error: "invalid_proof" });
      const accepted = catalog.castVote(poll.id, optionId, proof.nullifier, randomUUID(), now.toISOString());
      if (!accepted.ok) {
        if (accepted.reason === "duplicate") return json(409, { error: "duplicate_vote" });
        if (accepted.reason === "closed") return json(409, { error: "poll_closed" });
        return json(404, { error: "poll_not_found" });
      }
      return json(201, { receipt: accepted.receipt });
    }
    function handleResults(encodedId: string) {
      const id = decodeSegment(encodedId);
      if (id === undefined) return json(400, { error: "invalid_poll_id" });
      const result = catalog.results(id);
      return result ? json(200, { result }) : json(404, { error: "poll_not_found" });
    }
    function handleReceipt(encodedId: string) {
      const id = decodeSegment(encodedId);
      if (id === undefined) return json(400, { error: "invalid_receipt_id" });
      const receipt = catalog.receipt(id);
      return receipt ? json(200, { receipt }) : json(404, { error: "receipt_not_found" });
    }
    const voteMatch = pathname.match(/^\/api\/polls\/(.+)\/votes$/);
    if (voteMatch) {
      if (request.method !== "POST") { response.setHeader("Allow", "POST"); return json(405, { error: "method_not_allowed" }); }
      handleVote(voteMatch[1]).catch(error => { console.error(error); if (!response.headersSent) json(500, { error: "internal_error" }); });
      return;
    }
    const resultsMatch = pathname.match(/^\/api\/polls\/(.+)\/results$/);
    if (resultsMatch) {
      if (request.method !== "GET") { response.setHeader("Allow", "GET"); return json(405, { error: "method_not_allowed" }); }
      return handleResults(resultsMatch[1]);
    }
    const receiptMatch = pathname.match(/^\/api\/receipts\/(.+)$/);
    if (receiptMatch) {
      if (request.method !== "GET") { response.setHeader("Allow", "GET"); return json(405, { error: "method_not_allowed" }); }
      return handleReceipt(receiptMatch[1]);
    }
    if (request.method !== "GET") { response.setHeader("Allow", "GET"); return json(405, { error: "method_not_allowed" }); }
    if (pathname === "/api/health") return json(200, { service: "veilvote", status: "ok" });
    if (pathname === "/api/polls") return json(200, { polls: catalog.list() });
    if (pathname.startsWith("/api/polls/")) {
      const id = decodeSegment(pathname.slice("/api/polls/".length));
      if (id === undefined) return json(400, { error: "invalid_poll_id" });
      const poll = catalog.get(id);
      return poll ? json(200, { poll }) : json(404, { error: "poll_not_found" });
    }
    if (pathname.startsWith("/api/")) return json(404, { error: "not_found" });
    let relativePath: string;
    try { relativePath = decodeURIComponent(pathname); }
    catch { return json(400, { error: "invalid_path" }); }
    const file = resolve(publicPath, relativePath === "/" ? "index.html" : `.${relativePath}`);
    if (!file.startsWith(`${resolve(publicPath)}${sep}`) || !existsSync(file) || !statSync(file).isFile()) return json(404, { error: "not_found" });
    response.writeHead(200, { "Content-Type": mime[extname(file)] ?? "application/octet-stream", "X-Content-Type-Options": "nosniff" });
    response.end(readFileSync(file));
  });
  server.on("close", () => catalog.close());
  return server;
}
