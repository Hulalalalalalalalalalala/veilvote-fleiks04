// Replaces the Semaphore proof stack while bundling the frontend for DOM
// interaction tests. The browser proof stack is large and only reached from
// the vote button handler; receipt/audit/results flows never import it, and
// vote acceptance itself is covered by the API-level tests.
const message = "零知识证明栈在 DOM 测试中已被替换；投票请走 API 层测试。";
export class Identity {
  constructor() { throw new Error(message); }
}
export class Group {
  constructor() { throw new Error(message); }
}
export async function generateProof(): Promise<never> { throw new Error(message); }
