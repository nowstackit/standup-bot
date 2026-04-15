import { WebClient } from "@slack/web-api";
import type {
  ChannelConfig,
  ChannelPattern,
  NormalizedMessage,
} from "./types.js";

const botToken = process.env.SLACK_BOT_TOKEN;
if (!botToken) console.warn("[slack] SLACK_BOT_TOKEN is not set");

const userToken = process.env.SLACK_USER_TOKEN;
if (!userToken)
  console.warn(
    "[slack] SLACK_USER_TOKEN is not set — bot must be invited to channels manually",
  );

// Bot token: used only for posting messages.
export const slack = new WebClient(botToken);

// User token: used for all reads (history, replies, user info, channel list).
// With user scopes the token can read any channel the installing user is a member
// of, without needing the bot to be invited.
const reader = new WebClient(userToken ?? botToken);

// In-memory user cache so we don't hammer users.info on every run.
const userCache = new Map<string, string>();

let cachedWorkspaceUrl: string | null = null;

export async function getWorkspaceUrl(): Promise<string> {
  if (cachedWorkspaceUrl) return cachedWorkspaceUrl;
  const res = await reader.auth.test();
  const url = (res as any).url as string;
  cachedWorkspaceUrl = url.replace(/\/$/, "");
  return cachedWorkspaceUrl;
}

function buildPermalink(
  workspaceUrl: string,
  channelId: string,
  ts: string,
): string {
  return `${workspaceUrl}/archives/${channelId}/p${ts.replace(".", "")}`;
}

export async function resolveUser(userId: string): Promise<string> {
  if (!userId) return "unknown";
  if (userCache.has(userId)) return userCache.get(userId)!;
  try {
    const res = await reader.users.info({ user: userId });
    const name =
      (res.user as any)?.profile?.display_name ||
      (res.user as any)?.profile?.real_name ||
      (res.user as any)?.name ||
      userId;
    userCache.set(userId, name);
    return name;
  } catch {
    userCache.set(userId, userId);
    return userId;
  }
}

/**
 * Replace Slack mrkdwn tokens in message text with readable equivalents:
 *   <@U123ABC>        → @displayname  (userCache must be populated first)
 *   <#C123ABC|name>   → #name
 *   <!here>           → @here
 *   <!channel>        → @channel
 *   <!everyone>       → @everyone
 *   <https://...|txt> → txt
 *   <https://...>     → https://...
 */
function resolveSlackText(text: string): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)>/g, (_, id) => `@${userCache.get(id) ?? id}`)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, (_, name) => `#${name}`)
    .replace(/<!here>/g, "@here")
    .replace(/<!channel>/g, "@channel")
    .replace(/<!everyone>/g, "@everyone")
    .replace(/<([^|>]+)\|([^>]+)>/g, (_, _url, label) => label)
    .replace(/<(https?:[^>]+)>/g, (_, url) => url);
}

let cachedBotUserId: string | null = null;

async function getBotUserId(): Promise<string> {
  if (cachedBotUserId) return cachedBotUserId;
  const res = await slack.auth.test();
  cachedBotUserId = (res as any).user_id as string;
  return cachedBotUserId;
}

/** Returns true if a standup brief was already posted today in the given channel. */
export async function checkBriefPostedToday(
  channelId: string,
): Promise<boolean> {
  const botUserId = await getBotUserId();
  const oldest = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
  try {
    const res: any = await reader.conversations.history({
      channel: channelId,
      oldest: String(oldest),
      limit: 100,
    });
    return (res.messages ?? []).some(
      (m: any) =>
        m.user === botUserId && (m.text ?? "").includes("Standup Brief"),
    );
  } catch {
    return false;
  }
}

/**
 * Window helper. Standups are Mon-Fri at 10:30 IST. On Mondays we want a
 * 72h window so we capture Friday + weekend chatter; on Tue-Fri we just
 * want the last 24h.
 */
export function getWindow(now = new Date()): {
  oldest: number;
  hours: number;
  isMonday: boolean;
} {
  const istNow = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
  );
  const dow = istNow.getDay(); // 0 = Sun, 1 = Mon
  const isMonday = dow === 1;
  const hours = isMonday ? 72 : 24;
  const oldest = Math.floor((now.getTime() - hours * 60 * 60 * 1000) / 1000);
  return { oldest, hours, isMonday };
}

function matchesPattern(name: string, pattern: string): boolean {
  if (pattern.startsWith("*")) return name.endsWith(pattern.slice(1));
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

/**
 * Discover all channels the installing user can see that match any pattern.
 * Uses the user token so no bot invite is needed.
 */
export async function discoverPatternChannels(
  patterns: ChannelPattern[],
  excludeIds: Set<string>,
  excludeNames: Set<string> = new Set(),
): Promise<ChannelConfig[]> {
  const discovered: ChannelConfig[] = [];
  let cursor: string | undefined;

  do {
    const res: any = await reader.conversations.list({
      limit: 200,
      cursor,
      types: "public_channel,private_channel,mpim",
      exclude_archived: true,
    });
    for (const ch of res.channels ?? []) {
      if (
        !ch.id ||
        !ch.name ||
        excludeIds.has(ch.id) ||
        excludeNames.has(ch.name)
      )
        continue;
      for (const p of patterns) {
        if (!matchesPattern(ch.name, p.pattern)) continue;
        discovered.push({
          id: ch.id,
          name: ch.name,
          business_line: p.business_line,
          function: p.function,
          priority: p.priority,
        });
        break;
      }
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return discovered;
}

/** Fetch all messages in a channel since `oldest` (paginated). */
export async function fetchChannelMessages(
  channel: ChannelConfig,
  oldest: number,
  excludeBots: boolean,
  workspaceUrl: string,
): Promise<NormalizedMessage[]> {
  const out: NormalizedMessage[] = [];
  let cursor: string | undefined = undefined;

  do {
    const res: any = await reader.conversations.history({
      channel: channel.id,
      oldest: String(oldest),
      limit: 200,
      cursor,
    });
    const msgs = (res.messages ?? []) as any[];
    for (const m of msgs) {
      if (!m || m.subtype === "channel_join" || m.subtype === "channel_leave")
        continue;
      if (excludeBots && (m.bot_id || m.subtype === "bot_message")) continue;
      if (!m.text || !m.user) continue;
      out.push({
        ts: m.ts,
        user_id: m.user,
        user: m.user,
        text: m.text,
        thread_ts: m.thread_ts,
        reply_count: m.reply_count ?? 0,
        reactions: (m.reactions ?? []).map((r: any) => ({
          name: r.name,
          count: r.count,
        })),
      });
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  // Pull thread replies concurrently for all messages that have replies.
  const threadFetches = out
    .filter((m) => (m.reply_count ?? 0) > 0 && m.thread_ts)
    .map(async (m) => {
      try {
        const r: any = await reader.conversations.replies({
          channel: channel.id,
          ts: m.thread_ts!,
          oldest: String(oldest),
          limit: 200,
        });
        const replies = (r.messages ?? []) as any[];
        return replies.slice(1).flatMap((reply: any) => {
          if (excludeBots && (reply.bot_id || reply.subtype === "bot_message"))
            return [];
          if (!reply.text || !reply.user) return [];
          return [
            {
              ts: reply.ts,
              user_id: reply.user,
              user: reply.user,
              text: `↳ (in thread) ${reply.text}`,
              thread_ts: reply.thread_ts,
            } as NormalizedMessage,
          ];
        });
      } catch (e) {
        console.warn(
          `[slack] failed to fetch thread for ${channel.name}:${m.ts}`,
          e,
        );
        return [];
      }
    });

  const threadReplies = (await Promise.all(threadFetches)).flat();
  out.push(...threadReplies);

  // Resolve display names for message authors + any @mentions inside text.
  const mentionIds = Array.from(
    new Set(
      out.flatMap((m) => {
        const ids: string[] = [];
        for (const match of m.text.matchAll(/<@([UW][A-Z0-9]+)>/g)) {
          ids.push(match[1]);
        }
        return ids;
      }),
    ),
  );
  const uniqueUsers = Array.from(
    new Set([...out.map((m) => m.user_id), ...mentionIds]),
  );
  await Promise.all(uniqueUsers.map(resolveUser));
  for (const m of out) {
    m.user = userCache.get(m.user_id) ?? m.user_id;
    m.text = resolveSlackText(m.text);
  }

  // Build permalinks locally — no extra API calls.
  for (const m of out) {
    if (!m.text.startsWith("↳")) {
      m.permalink = buildPermalink(workspaceUrl, channel.id, m.ts);
    }
  }

  return out;
}

/** Post a Block Kit message to the configured standup channel. Returns the message ts. */
export async function postBriefing(
  channelId: string,
  blocks: any[],
  text: string,
): Promise<string> {
  const res = await slack.chat.postMessage({
    channel: channelId,
    text,
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  });
  return res.ts as string;
}

/** Post a Block Kit reply into a thread. */
export async function postReply(
  channelId: string,
  threadTs: string,
  blocks: any[],
  text: string,
) {
  return slack.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text,
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  });
}
