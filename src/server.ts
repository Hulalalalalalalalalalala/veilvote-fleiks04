import { resolve } from "node:path";
import { createApp } from "./app.ts";

const port = Number(process.env.PORT ?? 3414);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer between 0 and 65535");
// Administrative endpoints require X-Admin-Token to match ADMIN_TOKEN. With no
// token configured every management request is refused with 401.
const adminToken = process.env.ADMIN_TOKEN?.trim() || undefined;
const server = createApp(resolve(process.env.DATA_DIR ?? "data", "veilvote.sqlite"), resolve("dist/public"), { adminToken });
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") console.log(`VeilVote is available at http://127.0.0.1:${address.port}`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close());
