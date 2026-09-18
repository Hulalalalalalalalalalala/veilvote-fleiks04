import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { openCatalog } from "./store.ts";

export function createApp(databasePath: string, publicPath = resolve("dist/public")) {
  const catalog = openCatalog(databasePath);
  const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8" };
  const server = createServer((request, response) => {
    function json(status: number, payload: unknown) {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify(payload));
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method !== "GET") { response.setHeader("Allow", "GET"); return json(405, { error: "method_not_allowed" }); }
    if (url.pathname === "/api/health") return json(200, { service: "veilvote", status: "ok" });
    if (url.pathname === "/api/polls") return json(200, { polls: catalog.list() });
    if (url.pathname.startsWith("/api/polls/")) {
      let id: string;
      try { id = decodeURIComponent(url.pathname.slice("/api/polls/".length)); }
      catch { return json(400, { error: "invalid_poll_id" }); }
      const poll = catalog.get(id);
      return poll ? json(200, { poll }) : json(404, { error: "poll_not_found" });
    }
    if (url.pathname.startsWith("/api/")) return json(404, { error: "not_found" });
    let relativePath: string;
    try { relativePath = decodeURIComponent(url.pathname); }
    catch { return json(400, { error: "invalid_path" }); }
    const file = resolve(publicPath, relativePath === "/" ? "index.html" : `.${relativePath}`);
    if (!file.startsWith(`${resolve(publicPath)}${sep}`) || !existsSync(file) || !statSync(file).isFile()) return json(404, { error: "not_found" });
    response.writeHead(200, { "Content-Type": mime[extname(file)] ?? "application/octet-stream", "X-Content-Type-Options": "nosniff" });
    response.end(readFileSync(file));
  });
  server.on("close", () => catalog.close());
  return server;
}
