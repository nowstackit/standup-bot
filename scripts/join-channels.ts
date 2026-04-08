/**
 * One-time setup script: scans ALL workspace channels, joins public ones
 * matching the configured patterns, and prints a list of private/Slack Connect
 * channels that need a manual /invite @standup-bot.
 *
 * Usage:
 *   npx tsx scripts/join-channels.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebClient } from "@slack/web-api";
import type { ChannelsFile } from "../lib/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(
  readFileSync(join(__dirname, "../config/channels.json"), "utf8"),
) as ChannelsFile;
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

function matchesPattern(name: string, pattern: string): boolean {
  if (pattern.startsWith("*")) return name.endsWith(pattern.slice(1));
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

async function main() {
  const patterns = cfg.channel_patterns ?? [];
  if (patterns.length === 0) {
    console.log("No channel_patterns configured. Nothing to do.");
    return;
  }

  const staticIds = new Set(cfg.channels.map((c) => c.id));
  const joined: string[] = [];
  const needsInvite: string[] = [];
  const alreadyIn: string[] = [];
  let total = 0;
  let cursor: string | undefined;

  console.log("Scanning workspace channels...\n");

  do {
    const res: any = await slack.conversations.list({
      limit: 200,
      cursor,
      types: "public_channel,private_channel",
      exclude_archived: true,
    });

    for (const ch of res.channels ?? []) {
      if (!ch.id || !ch.name || staticIds.has(ch.id)) continue;
      const matchedPattern = patterns.find((p) =>
        matchesPattern(ch.name, p.pattern),
      );
      if (!matchedPattern) continue;

      total++;

      if (ch.is_member) {
        alreadyIn.push(`#${ch.name}`);
        continue;
      }

      const isPrivate = ch.is_private || ch.is_ext_shared || ch.is_org_shared;
      if (isPrivate) {
        needsInvite.push(`#${ch.name}  (${ch.id})`);
        continue;
      }

      try {
        await slack.conversations.join({ channel: ch.id });
        joined.push(`#${ch.name}`);
      } catch (e: any) {
        needsInvite.push(
          `#${ch.name}  (${ch.id}) — join failed: ${e?.message ?? e}`,
        );
      }
    }

    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  console.log(`Found ${total} channels matching patterns.\n`);

  if (alreadyIn.length) {
    console.log(`✅ Already a member (${alreadyIn.length}):`);
    alreadyIn.forEach((c) => console.log("  ", c));
    console.log();
  }

  if (joined.length) {
    console.log(`🟢 Auto-joined (${joined.length}):`);
    joined.forEach((c) => console.log("  ", c));
    console.log();
  }

  if (needsInvite.length) {
    console.log(
      `⚠️  Need manual /invite @standup-bot (${needsInvite.length}):`,
    );
    needsInvite.forEach((c) => console.log("  ", c));
    console.log(
      "\nFor each channel above, open it in Slack and type: /invite @standup-bot",
    );
  }

  if (needsInvite.length === 0 && joined.length === 0) {
    console.log(
      "Nothing to do — bot is already a member of all matching channels.",
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
