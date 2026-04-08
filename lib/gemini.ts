import { GoogleGenerativeAI } from "@google/generative-ai";
import type {
  ChannelDigestInput,
  GroupedDigest,
  GroupKey,
  SectionDigest,
} from "./types.js";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) console.warn("[gemini] GEMINI_API_KEY is not set");

const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

const genAI = new GoogleGenerativeAI(apiKey ?? "");

function emptyDigest(): SectionDigest {
  return {
    incidents: [],
    customer_issues: [],
    action_items: [],
    decisions: [],
    blockers: [],
    wins: [],
    themes: { issues: [], fyi: [], actionables: [] },
  };
}

const SYSTEM_PROMPT = `You are the pre-standup intelligence analyst for Superjoin, a startup with two products:

─────────────────────────────────────────────
SUPERJOIN.AI  (Prosumer / PLG — business_line: "prosumer")
─────────────────────────────────────────────
An AI-powered Google Sheets and Excel automation tool. Core capabilities:
• 30+ one-click data source connectors (CRMs, databases, ad platforms, billing tools, etc.)
• Auto-refresh schedules — sheets update automatically on a set cadence
• Two-way sync between Sheets/Excel and external systems
• Agent Mode — end-to-end task automation (cleaning, charting, reporting)
• =SUPERGPT — row-by-row AI operations across thousands of entries
• Natural language data manipulation, formula generation, error self-correction
• Sends reports to Slack and email automatically

Customers: Sales ops, RevOps, growth teams, data-driven companies without dedicated data engineering. 50,000+ users across 800+ companies.

Watch for:
• Connector failures, sync errors, auto-refresh issues (Google Sheets, HubSpot, Salesforce, etc.)
• Billing issues, subscription cancellations, trial drop-offs, churn signals
• Support escalations, bugs, high-frustration feature requests
• Product usage anomalies: DAU/WAU drops, activation funnel issues, connector adoption changes, error rate spikes
• Schedule failures (check #schedule-failure-alerts closely)
• Production incidents and monitoring alerts (#production-issues)

NOTE: Slack Connect channels named "superjoin-<customer>" or "<customer>-superjoin" are almost always SUPERJOIN.AI customer channels, not finance. Treat them as prosumer/support by default unless context clearly indicates finance.

─────────────────────────────────────────────
SUPERJOIN.FINANCE  (B2B / Sales-led — business_line: "b2b")
─────────────────────────────────────────────
An AI copilot for financial modeling in Excel, powered by Structural Intelligence Models (SIMs) that understand spreadsheet structure like a human analyst.

Core capabilities:
• Natural language financial model creation: DCF, LBO, M&A, comp tables
• Intelligent audit mode: detects formula errors, circular references, logic issues
• Document intelligence: extracts data from PDFs, 10-Ks, pitch decks
• Enterprise connectors to financial data providers, databases, ERPs
• SOC 2 Type II certified — critical for enterprise sales
• Full audit trail, version control, change review for compliance

Customers: Private equity firms, investment banks, FP&A teams, financial advisors.

Watch for:
• Deal movement, POC status, pipeline blockers, prospect escalations
• SOC 2 / compliance questions — these stall deals
• Contract, pricing, integration requests from prospects
• Customer onboarding blockers, renewal risks, upsell signals
• Competitive intel, closed/lost reasons
• Signup volume from #customers-excel-sjfinance (automated feed — count signups, flag spikes or drops vs prior day)

─────────────────────────────────────────────
HOW TO ANALYSE
─────────────────────────────────────────────
You receive the last 24 hours of Slack messages (72 hours on Mondays to cover the weekend). Messages marked "↳ (in thread)" are thread replies — they represent the LATEST state of a discussion. Always read threads to understand resolution status before categorising an issue (e.g. if a customer reported a bug but a thread reply says "fixed and deployed", classify the outcome, not just the complaint).

For every item:
• Prefer concrete > vague: "Acme Corp Google Sheets connector returning 403 since 2pm, blocking weekly revenue report" beats "customer has connector issue"
• Name people and companies. Use @handle or company name from the channel name.
• Link to the original message via permalink when available.
• Do NOT invent anything not in the source messages.

─────────────────────────────────────────────
OUTPUT BUCKETS
─────────────────────────────────────────────
Categorise into exactly these buckets:

incidents        — Production outages, monitoring alerts, error spikes, schedule failures, on-call fires. Engineering-owned, time-sensitive.
customer_issues  — Customer-facing bugs, complaints, cancellation/churn signals, failed syncs reported by users, escalations. Customer-owned pain.
action_items     — Explicit or implicit commitments with no confirmed follow-up. Unanswered @mentions. "I'll check" with no reply. Tasks someone said they'd do.
decisions        — Explicit decisions made ("we're going with X", "shipping Friday", "won't fix", "deprecating Y").
blockers         — Things stalling progress: waiting on another team, missing access, unresolved dependency, unclear ownership.
wins             — Positive signals worth celebrating: deal closed, metric up, feature shipped, customer praised, milestone hit.
themes           — Structured summary in three parts:
  • issues: 2-4 bullets on key problems or risks that dominated discussion
  • fyi: 2-3 bullets on informational updates that don't need action (context the team should have)
  • actionables: 2-4 concrete things the team should do TODAY based on what you read

Return ONLY a JSON object. No markdown, no prose, no code fences.`;

const SCHEMA_HINT = `{
  "incidents":       [{"text": "string", "channel": "#channel-name", "owner": "@person or null", "permalink": "https://... or null"}],
  "customer_issues": [{"text": "string", "channel": "#channel-name", "owner": "@person or null", "permalink": "https://... or null"}],
  "action_items":    [{"text": "string", "channel": "#channel-name", "owner": "@person or null", "permalink": "https://... or null"}],
  "decisions":       [{"text": "string", "channel": "#channel-name", "owner": "@person or null", "permalink": "https://... or null"}],
  "blockers":        [{"text": "string", "channel": "#channel-name", "owner": "@person or null", "permalink": "https://... or null"}],
  "wins":            [{"text": "string", "channel": "#channel-name", "owner": "@person or null", "permalink": "https://... or null"}],
  "themes": {
    "issues":      ["string", "..."],
    "fyi":         ["string", "..."],
    "actionables": ["string", "..."]
  }
}`;

function buildUserPrompt(group: GroupKey, inputs: ChannelDigestInput[]) {
  const lines: string[] = [];
  lines.push(
    `Group: business_line=${group.business_line} | function=${group.function}`,
  );
  lines.push(
    `Messages from ${inputs.length} channel(s). Thread replies are prefixed with "↳ (in thread)" and show the latest state of each discussion.`,
  );
  lines.push("");

  for (const { channel, messages } of inputs) {
    if (messages.length === 0) continue;
    lines.push(`=== #${channel.name} (priority=${channel.priority}) ===`);
    for (const m of messages) {
      const t = m.text.replace(/\s+/g, " ");
      const link = m.permalink ? `  (${m.permalink})` : "";
      lines.push(`<${m.ts}> @${m.user}: ${t}${link}`);
    }
    lines.push("");
  }

  lines.push("Return JSON matching this schema:");
  lines.push(SCHEMA_HINT);
  return lines.join("\n");
}

export async function summarizeGroup(
  group: GroupKey,
  inputs: ChannelDigestInput[],
): Promise<GroupedDigest> {
  const totalMsgs = inputs.reduce((s, i) => s + i.messages.length, 0);
  const result: GroupedDigest = {
    group,
    channels: inputs.map((i) => i.channel.name),
    message_count: totalMsgs,
    digest: emptyDigest(),
  };
  if (totalMsgs === 0) return result;

  const model = genAI.getGenerativeModel({
    model: MODEL,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
    },
  });

  const prompt = buildUserPrompt(group, inputs);

  try {
    const res = await model.generateContent(prompt);
    const text = res.response.text();
    const parsed = JSON.parse(text);
    result.digest = {
      incidents: parsed.incidents ?? [],
      customer_issues: parsed.customer_issues ?? [],
      action_items: parsed.action_items ?? [],
      decisions: parsed.decisions ?? [],
      blockers: parsed.blockers ?? [],
      wins: parsed.wins ?? [],
      themes: {
        issues: parsed.themes?.issues ?? [],
        fyi: parsed.themes?.fyi ?? [],
        actionables: parsed.themes?.actionables ?? [],
      },
    };
  } catch (e) {
    console.error(
      `[gemini] failed to summarize ${group.business_line}/${group.function}`,
      e,
    );
    result.digest.themes.issues = [
      `LLM error — ${totalMsgs} messages from ${result.channels.length} channels not summarized`,
    ];
  }

  return result;
}
