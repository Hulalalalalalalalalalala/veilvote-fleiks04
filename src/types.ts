export type PollStatus = "draft" | "open" | "closed" | "archived";
export interface PollOption { id: string; label: string }
export interface PollSummary {
  id: string;
  title: string;
  summary: string;
  organizer: string;
  status: PollStatus;
  publishedAt: string;
  closesAt: string;
  memberCount: number;
  optionCount: number;
}
export interface PollDetail extends PollSummary {
  description: string;
  options: PollOption[];
  eligibleMemberCommitments: string[];
  groupVersion: number;
  merkleRoot: string;
}
export interface GroupVersionSummary {
  pollId: string;
  version: number;
  merkleRoot: string;
  memberCount: number;
  commitments: string[];
}
export interface SemaphoreProofPayload {
  merkleTreeDepth: number;
  merkleTreeRoot: string;
  message: string;
  nullifier: string;
  scope: string;
  points: string[];
}
export interface VoteReceipt {
  id: string;
  pollId: string;
  optionId: string;
  nullifier: string;
  acceptedAt: string;
}
/**
 * Immutable tally captured in the same transaction that closes a poll. The
 * field order is part of the contract: digest is the lowercase hex SHA-256 of
 * the UTF-8 JSON.stringify of the first five fields, serialized in this order.
 */
export interface CloseSnapshot {
  pollId: string;
  groupVersion: number;
  total: number;
  options: { id: string; count: number }[];
  /** UTC instant of the close, formatted YYYY-MM-DDTHH:mm:ss.sssZ. */
  closedAt: string;
  digest: string;
}
export interface PollResults {
  pollId: string;
  total: number;
  options: { id: string; count: number }[];
  /** Present on closed/archived polls only; open polls have none. */
  snapshot?: CloseSnapshot;
}
/** Administrative actions recorded in the audit trail. */
export type AuditAction =
  | "poll_create"
  | "poll_status_change"
  | "group_change"
  | "group_change_rejected"
  | "status_change_rejected";
export interface AuditEvent {
  id: string;
  action: AuditAction;
  pollId: string;
  /** Whether the requested change was applied. */
  result: "success" | "failure";
  at: string;
  /** Action-specific, non-sensitive context (never the token, secrets or proofs). */
  details: Record<string, unknown>;
}
/** Filters for the paginated audit query; from/to are inclusive ISO8601 bounds. */
export interface AuditQuery {
  pollId?: string;
  action?: AuditAction;
  result?: "success" | "failure";
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}
export interface AuditPage {
  events: AuditEvent[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
