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
