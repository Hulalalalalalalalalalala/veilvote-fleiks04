// Minimal ambient declarations for test-only dependencies. jsdom is used only
// through the DOM harness in test/frontend.test.ts; the real type surface is
// trivial, and this avoids a network fetch for @types/jsdom during `npm ci`.
declare module "jsdom" {
  export interface JSDOMOptions {
    url?: string;
    runScripts?: string;
    pretendToBeVisual?: boolean;
    [key: string]: unknown;
  }
  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    readonly window: any;
  }
}
