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
  pattern: string;         // glob with leading/trailing * e.g. "superjoin-*" or "*-superjoin"
  business_line: BusinessLine;
  function: FunctionArea;
  priority: Priority;
}

export interface ChannelsFile {
  channels: ChannelConfig[];
  channel_patterns?: ChannelPattern[];
  post_to_channel: string;
  post_to_channel_name: string;
  timezone: string;
  exclude_bots: boolean;
  exclude_thread_replies_from_count: boolean;
  min_messages_to_summarize: number;
}

export interface NormalizedMessage {
  ts: string;
  user: string;          // resolved display name when possible
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
  channel: string;        // #channel-name
  permalink?: string;
  owner?: string;         // @user (best guess)
}

export interface SectionDigest {
  customer_issues: BriefingItem[];
  open_action_items: BriefingItem[];
  decisions: BriefingItem[];
  blockers: BriefingItem[];
  themes: string[];       // bullet themes for the group
}

export interface GroupKey {
  business_line: BusinessLine;
  function: FunctionArea;
}

export interface GroupedDigest {
  group: GroupKey;
  channels: string[];     // channel names included
  message_count: number;
  digest: SectionDigest;
}
