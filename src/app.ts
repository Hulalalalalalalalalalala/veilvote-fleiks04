import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { Group } from "@semaphore-protocol/group";
import { verifyProof, type SemaphoreProof } from "@semaphore-protocol/proof";
import { openCatalog } from "./store.ts";
import { isProofPayload, terminateProverWorkers, textToField } from "./voting.ts";

const MAX_BODY_BYTES = 1_000_000;

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
        if (segments[3] === "votes") {
          if (method !== "POST") return json(405, { error: "method_not_allowed" }, { Allow: "POST" });
          const poll = catalog.get(id);
          if (!poll) return json(404, { error: "poll_not_found" });
          let body: unknown;
          try { body = JSON.parse(await readBody(request)); }
          catch { return json(400, { error: "invalid_json" }); }
          if (typeof body !== "object" || body === null) return json(400, { error: "invalid_vote" });
          const { optionId, proof } = body as { optionId?: unknown; proof?: unknown };
          if (typeof optionId !== "string" || optionId.length === 0 || !isProofPayload(proof)) {
            return json(400, { error: "invalid_vote" });
          }
          if (!poll.options.some(option => option.id === optionId)) return json(400, { error: "unknown_option" });
          if (poll.status !== "open" || Date.now() >= Date.parse(poll.closesAt)) return json(409, { error: "poll_closed" });
          // The proof must be bound to this poll (scope), the chosen option
          // (message) and the current member tree (root) rebuilt from SQLite.
          const group = new Group(catalog.memberCommitments());
          let bound = false;
          try {
            bound =
              proof.scope === textToField(poll.id) &&
              proof.message === textToField(optionId) &&
              proof.merkleTreeRoot === group.root.toString();
          } catch { bound = false; }
          if (!bound) return json(422, { error: "proof_binding_mismatch" });
          let valid = false;
          proverUsed = true;
          try { valid = await verifyProof(proof as unknown as SemaphoreProof); }
          catch { valid = false; }
          if (!valid) return json(422, { error: "invalid_proof" });
          const outcome = catalog.commitVote(poll.id, optionId, proof.nullifier);
          if (!outcome.ok) {
            if (outcome.reason === "duplicate_nullifier") return json(409, { error: "duplicate_nullifier" });
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
