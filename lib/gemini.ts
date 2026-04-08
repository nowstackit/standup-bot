import { GoogleGenerativeAI } from "@google/generative-ai";
import type {
  ChannelDigestInput,
  GroupedDigest,
  GroupKey,
  SectionDigest,
} from "./types.js";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) console.warn("[gemini] GEMINI_API_KEY is not set");

// Gemini 2.0 Flash is fast, cheap, and great for structured summarization at
// the volume we need (60-70 channels). Swap to gemini-2.0-pro if you want
// higher quality and don't mind 3-4× the cost/latency.
const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

const genAI = new GoogleGenerativeAI(apiKey ?? "");

function emptyDigest(): SectionDigest {
  return {
    customer_issues: [],
    open_action_items: [],
    decisions: [],
    blockers: [],
    themes: [],
  };
}

const SYSTEM_PROMPT = `You are the pre-standup analyst for Superjoin, a startup with two products:
1. SUPERJOIN.AI (Prosumer / PLG) — self-serve, product-led, inbound users. A spreadsheet automation and data connector tool. Watch for:
   - Subscription/billing issues, cancellations, churn signals, trial drop-offs
   - Support tickets, bugs, production incidents, monitoring alerts, error spikes
   - Feature requests with high demand or user frustration
   - Product usage signals: activation drops, funnel conversion issues, adoption of new features, power user behaviour, anomalies in usage metrics shared in Slack (e.g. DAU/WAU changes, connector usage, error rates)
2. SUPERJOIN.FINANCE (B2B / Sales-led) — outbound, enterprise deals. A finance data and reporting platform. Watch for:
   - Deal movement, POC status, pipeline blockers, prospect escalations
   - Contract questions, pricing discussions, integration requests
   - Customer onboarding blockers, renewal risks, upsell signals
   - Closed/lost reasons and competitive intel
   - #customers-excel-sjfinance is an automated signup feed — count new signups, flag spikes or drops vs prior period, surface any anomalies in signup volume as a theme

Your job is to read the last 24-72 hours of Slack messages from one (business_line, function) group and produce a STRICTLY JSON digest that the team can scan in under 30 seconds before standup. Be specific, name names, link to threads. DO NOT invent anything not in the source messages.

For every item, prefer concrete > vague:
- "Acme Corp asked for SAML by EOW" beats "Customer asked about SSO"
- "DAU dropped 12% on Monday, connector errors spiked in Google Sheets" beats "Usage seems down"
- "On-call fired 3 times for high latency on /api/sync" beats "There were some errors"

Categorize into:
- customer_issues: bugs, outages, complaints, churn, escalations, anything a customer/user is unhappy about; also eng incidents (on-call alerts, error spikes, downtime)
- open_action_items: someone said they'd do X but no follow-up; unanswered @mentions; commitments without confirmation
- decisions: explicit decisions made ("we're going with X", "shipping Friday", "deprecating Y")
- blockers: things stalling progress, cross-team dependencies, waiting-on items, unresolved incidents
- themes: 2-4 short bullets capturing what dominated discussion, including any notable product usage patterns or metrics shared in the channel

Return ONLY a JSON object matching the schema. No markdown, no prose, no code fences.`;

const SCHEMA_HINT = `{
  "customer_issues":   [{"text": "string", "channel": "#channel-name", "owner": "@person or null", "permalink": "https://... or null"}],
  "open_action_items": [{"text": "string", "channel": "#channel-name", "owner": "@person or null", "permalink": "https://... or null"}],
  "decisions":         [{"text": "string", "channel": "#channel-name", "owner": "@person or null", "permalink": "https://... or null"}],
  "blockers":          [{"text": "string", "channel": "#channel-name", "owner": "@person or null", "permalink": "https://... or null"}],
  "themes":            ["string", "..."]
}`;

function buildUserPrompt(group: GroupKey, inputs: ChannelDigestInput[]) {
  const lines: string[] = [];
  lines.push(
    `Group: business_line=${group.business_line} | function=${group.function}`,
  );
  lines.push(
    `Below are the messages from ${inputs.length} channel(s). Each message is on its own line in the form: [#channel] <ts> @user: text  (permalink)`,
  );
  lines.push("");

  for (const { channel, messages } of inputs) {
    if (messages.length === 0) continue;
    lines.push(`=== #${channel.name} (priority=${channel.priority}) ===`);
    for (const m of messages) {
      const t = m.text.replace(/\s+/g, " ").slice(0, 800);
      const link = m.permalink ? `  (${m.permalink})` : "";
      lines.push(`<${m.ts}> @${m.user}: ${t}${link}`);
    }
    lines.push("");
  }

  lines.push("");
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
      customer_issues: parsed.customer_issues ?? [],
      open_action_items: parsed.open_action_items ?? [],
      decisions: parsed.decisions ?? [],
      blockers: parsed.blockers ?? [],
      themes: parsed.themes ?? [],
    };
  } catch (e) {
    console.error(
      `[gemini] failed to summarize ${group.business_line}/${group.function}`,
      e,
    );
    result.digest.themes = [
      `(LLM error — ${totalMsgs} messages from ${result.channels.length} channels not summarized)`,
    ];
  }

  return result;
}
