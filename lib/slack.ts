import { WebClient } from "@slack/web-api";
import type { ChannelConfig, ChannelPattern, NormalizedMessage } from "./types.js";

const token = process.env.SLACK_BOT_TOKEN;
if (!token) {
  console.warn("[slack] SLACK_BOT_TOKEN is not set");
}

export const slack = new WebClient(token);

// In-memory user cache so we don't hammer users.info on every run.
const userCache = new Map<string, string>();

let cachedWorkspaceUrl: string | null = null;

export async function getWorkspaceUrl(): Promise<string> {
  if (cachedWorkspaceUrl) return cachedWorkspaceUrl;
  const res = await slack.auth.test();
  const url = (res as any).url as string; // e.g. "https://myteam.slack.com/"
  cachedWorkspaceUrl = url.replace(/\/$/, "");
  return cachedWorkspaceUrl;
}

function buildPermalink(workspaceUrl: string, channelId: string, ts: string): string {
  return `${workspaceUrl}/archives/${channelId}/p${ts.replace(".", "")}`;
}

export async function resolveUser(userId: string): Promise<string> {
  if (!userId) return "unknown";
  if (userCache.has(userId)) return userCache.get(userId)!;
  try {
    const res = await slack.users.info({ user: userId });
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
 * Window helper. Standups are Mon-Fri at 10:30 IST. On Mondays we want a
 * 72h window so we capture Friday + weekend chatter; on Tue-Fri we just
 * want the last 24h.
 */
export function getWindow(now = new Date()): {
  oldest: number;
  hours: number;
  isMonday: boolean;
} {
  const istNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
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
 * Discover all workspace channels matching any pattern. For public channels the
 * bot isn't a member of, it will attempt to join automatically. Private/Slack
 * Connect channels the bot hasn't been invited to are logged and skipped.
 * excludeIds prevents re-adding channels already listed statically in config.
 */
export async function discoverPatternChannels(
  patterns: ChannelPattern[],
  excludeIds: Set<string>
): Promise<ChannelConfig[]> {
  const discovered: ChannelConfig[] = [];
  let cursor: string | undefined;

  do {
    const res: any = await slack.conversations.list({
      limit: 200,
      cursor,
      types: "public_channel,private_channel",
      exclude_archived: true,
    });
    for (const ch of res.channels ?? []) {
      if (!ch.id || !ch.name || excludeIds.has(ch.id)) continue;
      for (const p of patterns) {
        if (!matchesPattern(ch.name, p.pattern)) continue;

        // If the bot isn't a member yet, try to join.
        if (!ch.is_member) {
          if (ch.is_private || ch.is_ext_shared || ch.is_org_shared) {
            // Private / Slack Connect — can't self-join, needs an invite.
            console.warn(`[slack] not a member of private/connect channel #${ch.name} — invite @standup-bot to include it`);
            break;
          }
          try {
            await slack.conversations.join({ channel: ch.id });
            console.log(`[slack] auto-joined public channel #${ch.name}`);
          } catch (e) {
            console.warn(`[slack] failed to join #${ch.name}:`, e);
            break;
          }
        }

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
  workspaceUrl: string
): Promise<NormalizedMessage[]> {
  const out: NormalizedMessage[] = [];
  let cursor: string | undefined = undefined;

  do {
    const res: any = await slack.conversations.history({
      channel: channel.id,
      oldest: String(oldest),
      limit: 200,
      cursor,
    });
    const msgs = (res.messages ?? []) as any[];
    for (const m of msgs) {
      if (!m || m.subtype === "channel_join" || m.subtype === "channel_leave") continue;
      if (excludeBots && (m.bot_id || m.subtype === "bot_message")) continue;
      if (!m.text || !m.user) continue;
      out.push({
        ts: m.ts,
        user_id: m.user,
        user: m.user,
        text: m.text,
        thread_ts: m.thread_ts,
        reply_count: m.reply_count ?? 0,
        reactions: (m.reactions ?? []).map((r: any) => ({ name: r.name, count: r.count })),
      });
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  // Pull thread replies concurrently for all messages that have replies.
  const threadFetches = out
    .filter((m) => (m.reply_count ?? 0) > 0 && m.thread_ts)
    .map(async (m) => {
      try {
        const r: any = await slack.conversations.replies({
          channel: channel.id,
          ts: m.thread_ts!,
          oldest: String(oldest),
          limit: 200,
        });
        const replies = (r.messages ?? []) as any[];
        // skip the parent (first message)
        return replies.slice(1).flatMap((reply: any) => {
          if (excludeBots && (reply.bot_id || reply.subtype === "bot_message")) return [];
          if (!reply.text || !reply.user) return [];
          return [{
            ts: reply.ts,
            user_id: reply.user,
            user: reply.user,
            text: `↳ (in thread) ${reply.text}`,
            thread_ts: reply.thread_ts,
          } as NormalizedMessage];
        });
      } catch (e) {
        console.warn(`[slack] failed to fetch thread for ${channel.name}:${m.ts}`, e);
        return [];
      }
    });

  const threadReplies = (await Promise.all(threadFetches)).flat();
  out.push(...threadReplies);

  // Resolve display names concurrently.
  const uniqueUsers = Array.from(new Set(out.map((m) => m.user_id)));
  await Promise.all(uniqueUsers.map(resolveUser));
  for (const m of out) m.user = userCache.get(m.user_id) ?? m.user_id;

  // Build permalinks locally — no extra API calls.
  for (const m of out) {
    if (!m.text.startsWith("↳")) {
      m.permalink = buildPermalink(workspaceUrl, channel.id, m.ts);
    }
  }

  return out;
}

/** Post a Block Kit message to the configured standup channel. */
export async function postBriefing(channelId: string, blocks: any[], text: string) {
  return slack.chat.postMessage({
    channel: channelId,
    text,
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  });
}
