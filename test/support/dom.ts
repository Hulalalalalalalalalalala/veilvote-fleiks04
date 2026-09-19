import { JSDOM } from "jsdom";
import { build } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const webRoot = join(root, "web");
const stub = join(here, "semaphore-stub.ts");

let bundlePromise: Promise<string> | undefined;

/**
 * Bundles the production frontend entry (web/main.ts) with the real Vite
 * pipeline and returns the IIFE bundle source. The Semaphore proof packages
 * are aliased to a throwing stub: DOM tests exercise results, receipt and
 * audit interactions, while proof generation stays covered by the API tests.
 */
async function bundledApp(): Promise<string> {
  if (!bundlePromise) {
    bundlePromise = (async () => {
      const result = await build({
        root: webRoot,
        logLevel: "silent",
        configFile: false,
        build: {
          write: false,
          target: "es2023",
          rollupOptions: {
            input: join(webRoot, "main.ts"),
            output: { format: "iife", name: "VeilVoteApp", inlineDynamicImports: true }
          }
        },
        resolve: {
          alias: [
            { find: /^@semaphore-protocol\/identity$/, replacement: stub },
            { find: /^@semaphore-protocol\/group$/, replacement: stub },
            { find: /^@semaphore-protocol\/proof$/, replacement: stub }
          ]
        }
      }) as unknown as { output: { type: string; code?: string }[] } | { output: { type: string; code?: string }[] }[];
      const outputsList = Array.isArray(result) ? result : [result];
      const chunk = outputsList.flatMap(item => item.output ?? []).find(item => item.type === "chunk" && item.code);
      if (!chunk?.code) throw new Error("Frontend bundle produced no code");
      return chunk.code;
    })();
  }
  return bundlePromise;
}

export type DomWindow = InstanceType<typeof JSDOM>["window"];

export interface MountedApp {
  window: DomWindow;
  document: Document;
  /** Values handed to navigator.clipboard.writeText (jsdom has no clipboard). */
  clipboard: string[];
  /** Tear the page down (aborts in-flight fetches, clears timers). */
  close: () => void;
}

/**
 * Mounts the real frontend bundle into a jsdom page whose fetch reaches the
 * given real HTTP API base. Returns once the initial catalog request settles.
 */
export async function mountApp(base: string, initialHtml?: string): Promise<MountedApp> {
  const code = await bundledApp();
  const dom = new JSDOM(initialHtml ?? `<!doctype html><html><body><div id="app"></div></body></html>`, {
    url: `${base}/`,
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  const { window } = dom;
  // jsdom ships no fetch/Headers: install Node's primitives, rewriting the
  // app's absolute /api calls to the ephemeral server's base.
  const clipboard: string[] = [];
  const nodeFetch = globalThis.fetch;
  window.Headers = globalThis.Headers;
  window.Request = globalThis.Request;
  window.Response = globalThis.Response;
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    let path: string;
    if (typeof input === "string") path = input;
    else if (input instanceof URL) path = input.toString();
    else path = input.url;
    const resolved = path.startsWith("/") ? `${base}${path}` : path;
    return nodeFetch(resolved, init);
  };
  // The snapshot copy button uses the async clipboard API, absent in jsdom.
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: async (text: string) => { clipboard.push(text); } },
    configurable: true
  });
  // Run the IIFE inside the window scope so document/fetch/navigator and
  // every other global resolve to the page itself.
  window.eval(`${code}\n//# sourceURL=veilvote-app-bundle.js`);
  // main.ts awaits its initial loadPolls() at module top level; let those
  // microtasks and the chained render flush.
  await new Promise(resolve => setTimeout(resolve, 50));
  return { window, document: window.document, clipboard, close: () => window.close() };
}

/** Wait until `predicate(document)` is true or the timeout elapses. */
export async function waitFor(document: Document, predicate: (document: Document) => boolean, timeout = 3000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate(document)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`waitFor timed out after ${timeout}ms`);
}
