import type { BriefingItem, GroupedDigest } from "./types.js";

const BL_LABEL: Record<string, string> = {
  prosumer: "Superjoin.ai — Prosumer (PLG)",
  b2b: "Superjoin.finance — B2B (Sales-led)",
  shared: "Shared / Cross-team",
};

const FN_EMOJI: Record<string, string> = {
  product: ":hammer_and_wrench:",
  sales: ":moneybag:",
  support: ":sos:",
  ops: ":gear:",
  eng: ":construction:",
  marketing: ":mega:",
  leadership: ":crown:",
};

function fmtItem(it: BriefingItem): string {
  const owner = it.owner ? ` _(${it.owner})_` : "";
  if (it.permalink) {
    return `• <${it.permalink}|${it.channel}> — ${it.text}${owner}`;
  }
  return `• ${it.channel} — ${it.text}${owner}`;
}

function section(title: string, items: BriefingItem[]): string | null {
  if (!items || items.length === 0) return null;
  return `*${title}*\n${items.map(fmtItem).join("\n")}`;
}

/**
 * Main post — crisp, max ~8 highlight bullets.
 * Incidents and blockers are shown individually (always critical).
 * Customer issues shown individually if ≤ 3, else as a count.
 * Wins shown individually.
 */
export function composeMainPost(
  digests: GroupedDigest[],
  windowHours: number,
  isMonday: boolean,
): { blocks: any[]; fallbackText: string } {
  const blocks: any[] = [];

  const dateStr = new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "short",
    timeZone: "Asia/Kolkata",
  });

  const totalChannels = digests.reduce((s, d) => s + d.channels.length, 0);

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `:sunrise: Standup Brief — ${dateStr}` },
  });
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Last *${windowHours}h* across ${totalChannels} channels${isMonday ? " · Monday catch-up" : ""}`,
      },
    ],
  });
  blocks.push({ type: "divider" });

  const allIncidents = digests.flatMap((d) => d.digest.incidents);
  const allIssues = digests.flatMap((d) => d.digest.customer_issues);
  const allBlockers = digests.flatMap((d) => d.digest.blockers);
  const allWins = digests.flatMap((d) => d.digest.wins);

  if (allIncidents.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:rotating_light: *Incidents (${allIncidents.length})*\n${allIncidents.map(fmtItem).join("\n")}`,
      },
    });
  }

  if (allBlockers.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:no_entry: *Blockers (${allBlockers.length})*\n${allBlockers.map(fmtItem).join("\n")}`,
      },
    });
  }

  if (allIssues.length > 0) {
    const SHOW_INLINE = 3;
    let text: string;
    if (allIssues.length <= SHOW_INLINE) {
      text = `:warning: *Customer issues (${allIssues.length})*\n${allIssues.map(fmtItem).join("\n")}`;
    } else {
      const preview = allIssues.slice(0, SHOW_INLINE).map(fmtItem).join("\n");
      text = `:warning: *Customer issues (${allIssues.length})* — top ${SHOW_INLINE} shown, rest in thread\n${preview}`;
    }
    blocks.push({ type: "section", text: { type: "mrkdwn", text } });
  }

  if (allWins.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:tada: *Wins (${allWins.length})*\n${allWins.map(fmtItem).join("\n")}`,
      },
    });
  }

  if (
    allIncidents.length === 0 &&
    allIssues.length === 0 &&
    allBlockers.length === 0 &&
    allWins.length === 0
  ) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":white_check_mark: Nothing critical — quiet day.",
      },
    });
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: ":thread: Full breakdown by team in the thread below · `/standup-brief` to regenerate",
      },
    ],
  });

  const totalIssues = allIncidents.length + allIssues.length;
  const fallbackText = `Standup brief — ${dateStr}: ${totalIssues} issues, ${allBlockers.length} blockers, ${allWins.length} wins.`;
  return { blocks, fallbackText };
}

/**
 * Thread sections — one per business line, posted as replies.
 */
export function composeThreadSections(
  digests: GroupedDigest[],
): { label: string; blocks: any[] }[] {
  const order: Record<string, number> = { prosumer: 0, b2b: 1, shared: 2 };
  const sorted = [...digests].sort(
    (a, b) =>
      (order[a.group.business_line] ?? 9) - (order[b.group.business_line] ?? 9),
  );

  const byBL = new Map<string, GroupedDigest[]>();
  for (const d of sorted) {
    const key = d.group.business_line;
    if (!byBL.has(key)) byBL.set(key, []);
    byBL.get(key)!.push(d);
  }

  const sections: { label: string; blocks: any[] }[] = [];

  for (const [bl, groups] of byBL) {
    const activeGroups = groups.filter((g) => g.message_count > 0);
    if (activeGroups.length === 0) continue;

    const blocks: any[] = [];
    blocks.push({
      type: "header",
      text: { type: "plain_text", text: BL_LABEL[bl] ?? bl },
    });

    for (const g of activeGroups) {
      const emoji = FN_EMOJI[g.group.function] ?? ":small_blue_diamond:";
      const parts: string[] = [];

      parts.push(
        `${emoji} *${g.group.function.toUpperCase()}* — ${g.message_count} msgs across ${g.channels.map((c) => `#${c}`).join(", ")}`,
      );

      const { issues, actionables } = g.digest.themes;
      if (issues.length > 0) {
        parts.push(`*Issues*\n${issues.map((t) => `• ${t}`).join("\n")}`);
      }
      if (actionables.length > 0) {
        parts.push(
          `*Actionables*\n${actionables.map((t) => `• ${t}`).join("\n")}`,
        );
      }

      const full = parts.join("\n\n");
      for (const chunk of chunk3000(full)) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
      }
    }

    sections.push({ label: BL_LABEL[bl] ?? bl, blocks });
  }

  return sections;
}

function chunk3000(s: string): string[] {
  if (s.length <= 2900) return [s];
  const out: string[] = [];
  let buf = "";
  for (const line of s.split("\n")) {
    if (buf.length + line.length + 1 > 2900) {
      out.push(buf);
      buf = "";
    }
    buf += (buf ? "\n" : "") + line;
  }
  if (buf) out.push(buf);
  return out;
}
