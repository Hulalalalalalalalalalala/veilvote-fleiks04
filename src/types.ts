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
export interface VoteReceipt {
  id: string;
  pollId: string;
  optionId: string;
  nullifier: string;
  acceptedAt: string;
}
export interface PollOptionResult { id: string; count: number }
export interface PollResult {
  pollId: string;
  total: number;
  options: PollOptionResult[];
}
