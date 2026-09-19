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
export interface PollResults {
  pollId: string;
  total: number;
  options: { id: string; count: number }[];
}
export type AuditAction =
  | "poll_created"
  | "status_changed"
  | "members_changed"
  | "vote_accepted"
  | "vote_rejected";
export interface AuditEvent {
  id: string;
  at: string;
  action: AuditAction;
  pollId: string | null;
  result: "success" | "failure";
  detail: Record<string, unknown>;
}
