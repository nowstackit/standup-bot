import {
  discoverPatternChannels,
  fetchChannelMessages,
  getWindow,
  getWorkspaceUrl,
  postBriefing,
} from "./slack.js";
import { summarizeGroup } from "./gemini.js";
import { composeBriefing } from "./compose.js";
import type {
  ChannelDigestInput,
  ChannelsFile,
  GroupedDigest,
  GroupKey,
} from "./types.js";
import channelsConfig from "../config/channels.json" with { type: "json" };

const cfg = channelsConfig as unknown as ChannelsFile;

function groupKey(c: { business_line: string; function: string }): string {
  return `${c.business_line}::${c.function}`;
}

export async function runBrief(opts?: { dryRun?: boolean }) {
  const { oldest, hours, isMonday } = getWindow();
  console.log(
    `[brief] window=${hours}h isMonday=${isMonday} static_channels=${cfg.channels.length}`,
  );

  const workspaceUrl = await getWorkspaceUrl();

  // Auto-discover Slack Connect channels matching configured patterns.
  const staticIds = new Set(cfg.channels.map((c) => c.id));
  const patternChannels = cfg.channel_patterns?.length
    ? await discoverPatternChannels(cfg.channel_patterns, staticIds)
    : [];
  if (patternChannels.length > 0) {
    console.log(
      `[brief] discovered ${patternChannels.length} Slack Connect channels:`,
      patternChannels.map((c) => c.name).join(", "),
    );
  }
  const allChannels = [...cfg.channels, ...patternChannels];

  // 1. Fetch messages for every channel in parallel (capped concurrency).
  const fetched: ChannelDigestInput[] = [];
  const concurrency = 6;
  let i = 0;
  async function worker() {
    while (i < allChannels.length) {
      const idx = i++;
      const ch = allChannels[idx];
      try {
        const messages = await fetchChannelMessages(
          ch,
          oldest,
          cfg.exclude_bots,
          workspaceUrl,
        );
        fetched.push({ channel: ch, messages });
        console.log(`[brief]  ${ch.name}: ${messages.length} msgs`);
      } catch (e) {
        console.error(`[brief] failed ${ch.name}`, e);
        fetched.push({ channel: ch, messages: [] });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  // 2. Group by (business_line, function) and skip groups under threshold.
  const groups = new Map<string, ChannelDigestInput[]>();
  for (const f of fetched) {
    const k = groupKey(f.channel);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(f);
  }

  const digests: GroupedDigest[] = [];
  for (const [k, inputs] of groups) {
    const total = inputs.reduce((s, x) => s + x.messages.length, 0);
    const [business_line, fn] = k.split("::");
    const group: GroupKey = {
      business_line: business_line as any,
      function: fn as any,
    };
    if (total < cfg.min_messages_to_summarize) {
      digests.push({
        group,
        channels: inputs.map((x) => x.channel.name),
        message_count: total,
        digest: {
          customer_issues: [],
          open_action_items: [],
          decisions: [],
          blockers: [],
          themes:
            total === 0
              ? []
              : [`Quiet (${total} msgs) — skipped detailed summary.`],
        },
      });
      continue;
    }
    const d = await summarizeGroup(group, inputs);
    digests.push(d);
  }

  // 3. Compose Block Kit + post.
  const { blocks, fallbackText } = composeBriefing(digests, hours, isMonday);

  if (opts?.dryRun) {
    console.log("[brief] DRY RUN — would post to", cfg.post_to_channel_name);
    console.log(JSON.stringify(blocks, null, 2));
    return { posted: false, blocks, fallbackText, digests };
  }

  await postBriefing(cfg.post_to_channel, blocks, fallbackText);
  console.log(`[brief] posted to #${cfg.post_to_channel_name}`);
  return { posted: true, blocks, fallbackText, digests };
}
