export interface PollOption { id: string; label: string }
export interface PollSummary {
  id: string;
  title: string;
  summary: string;
  organizer: string;
  status: "open";
  publishedAt: string;
  closesAt: string;
  memberCount: number;
  optionCount: number;
}
export interface PollDetail extends PollSummary {
  description: string;
  options: PollOption[];
  eligibleMemberCommitments: string[];
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
