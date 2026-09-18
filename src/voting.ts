import type { SemaphoreProofPayload } from "./types.ts";

/**
 * Encodes a short UTF-8 string the same way @semaphore-protocol/proof converts
 * string messages and scopes: bytes32 left-aligned, big-endian (ethers
 * `encodeBytes32String` + `toBigInt`). Poll and option ids are ASCII slugs well
 * under the 31-byte limit.
 */
export function textToField(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > 31) throw new Error(`Value does not fit a bytes32 field: ${value}`);
  const padded = new Uint8Array(32);
  padded.set(bytes);
  return BigInt(`0x${Buffer.from(padded).toString("hex")}`).toString();
}

const DECIMAL = /^(0|[1-9]\d*)$/;
// BN254 scalar field order: commitments must be canonical field elements.
const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Structural check of a Semaphore identity commitment received over the wire. */
export function isCommitment(value: unknown): value is string {
  return typeof value === "string" && DECIMAL.test(value) && BigInt(value) < FIELD_MODULUS;
}

/**
 * snarkjs keeps a pool of worker MessagePorts alive after proof generation or
 * verification, which would otherwise prevent the process from exiting. Call
 * this once no more proofs will be produced or verified.
 */
export async function terminateProverWorkers(): Promise<void> {
  const snarkjs = await import("snarkjs");
  const curve = await snarkjs.curves.getCurveFromName("bn128");
  await curve.terminate();
}

/** Structural check of a Semaphore proof received over the wire. */
export function isProofPayload(value: unknown): value is SemaphoreProofPayload {
  if (typeof value !== "object" || value === null) return false;
  const proof = value as Record<string, unknown>;
  return (
    Number.isInteger(proof.merkleTreeDepth) &&
    (proof.merkleTreeDepth as number) >= 1 &&
    (proof.merkleTreeDepth as number) <= 32 &&
    typeof proof.merkleTreeRoot === "string" && DECIMAL.test(proof.merkleTreeRoot) &&
    typeof proof.message === "string" && DECIMAL.test(proof.message) &&
    typeof proof.nullifier === "string" && DECIMAL.test(proof.nullifier) &&
    typeof proof.scope === "string" && DECIMAL.test(proof.scope) &&
    Array.isArray(proof.points) &&
    proof.points.length === 8 &&
    proof.points.every(point => typeof point === "string" && DECIMAL.test(point))
  );
}
