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

export function composeBriefing(
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

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `:sunrise: Standup Brief — ${dateStr}` },
  });
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Last *${windowHours}h* across ${digests.reduce((s, d) => s + d.channels.length, 0)} channels${isMonday ? " · Monday catch-up window" : ""}`,
      },
    ],
  });

  // ── Top-of-brief alarms ─────────────────────────────────────────────────
  const topIncidents = digests.flatMap((d) => d.digest.incidents);
  const topCustomerIssues = digests.flatMap((d) => d.digest.customer_issues);
  const topBlockers = digests.flatMap((d) => d.digest.blockers);
  const topWins = digests.flatMap((d) => d.digest.wins);

  if (topIncidents.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:rotating_light: *Incidents (${topIncidents.length})*\n${topIncidents.map(fmtItem).join("\n")}`,
      },
    });
  }

  if (topCustomerIssues.length > 0) {
    if (topIncidents.length === 0) blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:warning: *Customer issues (${topCustomerIssues.length})*\n${topCustomerIssues.map(fmtItem).join("\n")}`,
      },
    });
  }

  if (topBlockers.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:no_entry: *Blockers (${topBlockers.length})*\n${topBlockers.map(fmtItem).join("\n")}`,
      },
    });
  }

  if (topWins.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:tada: *Wins (${topWins.length})*\n${topWins.map(fmtItem).join("\n")}`,
      },
    });
  }

  // ── Per-group sections ──────────────────────────────────────────────────
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

  for (const [bl, groups] of byBL) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "header",
      text: { type: "plain_text", text: BL_LABEL[bl] ?? bl },
    });

    for (const g of groups) {
      if (g.message_count === 0) continue;
      const emoji = FN_EMOJI[g.group.function] ?? ":small_blue_diamond:";
      const parts: string[] = [];

      parts.push(
        `${emoji} *${g.group.function.toUpperCase()}* — ${g.message_count} msgs across ${g.channels.map((c) => `#${c}`).join(", ")}`,
      );

      // Structured themes
      const { issues, fyi, actionables } = g.digest.themes;
      if (issues.length > 0) {
        parts.push(`*Issues*\n${issues.map((t) => `• ${t}`).join("\n")}`);
      }
      if (fyi.length > 0) {
        parts.push(`*FYI*\n${fyi.map((t) => `• ${t}`).join("\n")}`);
      }
      if (actionables.length > 0) {
        parts.push(
          `*Actionables*\n${actionables.map((t) => `• ${t}`).join("\n")}`,
        );
      }

      // Per-group detail sections
      const s1 = section("Action items", g.digest.action_items);
      const s2 = section("Decisions", g.digest.decisions);
      const s3 = section("Customer issues", g.digest.customer_issues);
      const s4 = section("Incidents", g.digest.incidents);
      const s5 = section("Blockers", g.digest.blockers);

      [s1, s2, s3, s4, s5]
        .filter(Boolean)
        .forEach((s) => parts.push(s as string));

      const full = parts.join("\n\n");
      for (const chunk of chunk3000(full)) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
      }
    }
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: ":robot_face: Auto-generated by superjoin-standup-bot · `/standup-brief` to regenerate",
      },
    ],
  });

  const totalIssues = topIncidents.length + topCustomerIssues.length;
  const fallbackText = `Standup brief — ${dateStr}: ${totalIssues} issues, ${topBlockers.length} blockers, ${topWins.length} wins across ${digests.length} groups.`;
  return { blocks, fallbackText };
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
