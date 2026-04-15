export type BusinessLine = "prosumer" | "b2b" | "shared";
export type FunctionArea =
  | "product"
  | "sales"
  | "support"
  | "ops"
  | "eng"
  | "marketing"
  | "leadership";
export type Priority = "high" | "medium" | "low";

export interface ChannelConfig {
  id: string;
  name: string;
  business_line: BusinessLine;
  function: FunctionArea;
  priority: Priority;
}

export interface ChannelPattern {
  pattern: string; // glob with leading/trailing * e.g. "superjoin-*" or "*-superjoin"
  business_line: BusinessLine;
  function: FunctionArea;
  priority: Priority;
}

export interface ChannelsFile {
  channels: ChannelConfig[];
  channel_patterns?: ChannelPattern[];
  blacklist_channels?: string[];
  post_to_channel: string;
  post_to_channel_name: string;
  timezone: string;
  exclude_bots: boolean;
  exclude_thread_replies_from_count: boolean;
  min_messages_to_summarize: number;
}

export interface NormalizedMessage {
  ts: string;
  user: string;
  user_id: string;
  text: string;
  thread_ts?: string;
  reply_count?: number;
  permalink?: string;
  reactions?: { name: string; count: number }[];
}

export interface ChannelDigestInput {
  channel: ChannelConfig;
  messages: NormalizedMessage[];
}

export interface BriefingItem {
  text: string;
  channel: string; // #channel-name
  permalink?: string;
  owner?: string; // @user (best guess)
}

export interface SectionDigest {
  incidents: BriefingItem[]; // prod outages, monitoring alerts, error spikes
  customer_issues: BriefingItem[]; // customer-facing bugs, complaints, churn, cancellations
  action_items: BriefingItem[]; // open commitments, unanswered @mentions, follow-ups
  decisions: BriefingItem[]; // explicit decisions made
  blockers: BriefingItem[]; // things stalling progress, cross-team dependencies
  wins: BriefingItem[]; // deals closed, good metrics, successful launches
  themes: {
    issues: string[]; // key problem patterns worth flagging
    fyi: string[]; // informational updates, no action needed
    actionables: string[]; // concrete things the team should act on today
  };
}

export interface GroupKey {
  business_line: BusinessLine;
  function: FunctionArea;
}

export interface GroupedDigest {
  group: GroupKey;
  channels: string[];
  message_count: number;
  digest: SectionDigest;
}
