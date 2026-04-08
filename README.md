# Superjoin Standup Bot

A Slack bot that posts a pre-standup briefing to `#standup` every weekday at **10:00 IST** (30 min before standup). It pulls the last 24h (72h on Mondays so it covers the weekend), runs the messages through Gemini, and produces a structured digest grouped by **business line → function**, with customer issues and blockers pulled to the top.

## What it surfaces

1. **Customer issues & incidents** (always at the top, impossible to miss)
2. **Blockers** anything stalling work
3. **Per-group sections**, each with:
   - Open action items / unanswered follow-ups
   - Decisions made
   - Customer issues
   - Blockers
   - 2-4 bullet themes

Groups are ordered: Prosumer (PLG) → B2B (Sales-led) → Shared/Cross-team. Within each business line, channels are split by function (sales, support, eng, ops, product, leadership).

## Architecture

```
Vercel Cron (04:30 UTC = 10:00 IST, Mon-Fri)
        │
        ▼
/api/cron/standup-brief.ts
        │
        ▼
lib/runBrief.ts
   1. fetch all configured channels (slack.ts) — concurrency 6
   2. group by (business_line, function)
   3. summarize each group with Gemini (gemini.ts)
   4. compose Block Kit message (compose.ts)
   5. post to #standup

/api/slack/command.ts  ← /standup-brief slash command (on-demand)
```

## Setup (30 minutes)

### 1. Create the Slack app

1. Go to https://api.slack.com/apps → **Create New App** → **From an app manifest**
2. Pick your workspace, paste the contents of `slack-manifest.yaml` (replace `YOUR-VERCEL-DOMAIN` later)
3. **Install to Workspace** → grab the **Bot User OAuth Token** (`xoxb-...`)
4. **Basic Information** → grab the **Signing Secret**
5. Invite the bot to every channel you want monitored: `/invite @standup-bot` (or use a Slack admin's bulk-invite tool)

### 2. Get a Gemini API key

https://aistudio.google.com/apikey → create key. Free tier easily covers 60-70 channels/day.

### 3. Fill in `config/channels.json`

Replace the example `C0XXXXXXXXX` IDs with your real channel IDs. To find a channel ID: open Slack in browser → channel URL ends in `/C0123ABCD`. Or right-click channel → View channel details → bottom of the popup.

For each channel set:

- `business_line`: `prosumer` | `b2b` | `shared`
- `function`: `product` | `sales` | `support` | `ops` | `eng` | `marketing` | `leadership`
- `priority`: `high` | `medium` | `low`

Set `post_to_channel` to the ID of `#standup`.

### 4. Deploy to Vercel

```bash
npm i -g vercel
cd standup-bot
npm install
vercel link            # link to your Vercel account
vercel env add SLACK_BOT_TOKEN
vercel env add SLACK_SIGNING_SECRET
vercel env add GEMINI_API_KEY
vercel env add CRON_SECRET    # any long random string
vercel deploy --prod
```

Copy the production URL (e.g. `https://superjoin-standup.vercel.app`) and update `slack-manifest.yaml` → save the manifest in your Slack app settings so the slash command points at the right place.

### 5. Test it

**Dry run locally** (does not post to Slack):

```bash
SLACK_BOT_TOKEN=xoxb-... GEMINI_API_KEY=... DRY_RUN=1 npx tsx scripts/run-local.ts
```

**On-demand from Slack**: type `/standup-brief` in any channel — the brief will post to `#standup`.

**Manually trigger the cron** from Vercel dashboard → Cron Jobs → Run.

## Tuning

| Knob                                  | Where                                              | What it does                                                                                       |
| ------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Window hours                          | `lib/slack.ts` `getWindow()`                       | Currently 24h normal, 72h on Mondays. Change to 48h if Sunday is too noisy.                        |
| Min messages to summarize a group     | `config/channels.json` `min_messages_to_summarize` | Skips LLM calls for quiet groups. Default 3.                                                       |
| Aggressiveness of follow-up detection | `lib/gemini.ts` `SYSTEM_PROMPT`                    | Prompt is currently "balanced". Edit the bullet definitions to be more conservative or aggressive. |
| Brief length                          | `lib/compose.ts`                                   | Caps top customer issues at 12 and blockers at 10. Bump if a noisy day truncates important items.  |
| Model                                 | env `GEMINI_MODEL`                                 | `gemini-2.0-flash` (default, cheap+fast) or `gemini-2.0-pro` (higher quality).                     |
| Cron time                             | `vercel.json` `crons[0].schedule`                  | `30 4 * * 1-5` = 04:30 UTC = 10:00 IST. UTC, not local.                                            |

## Costs

At ~70 channels with medium-low chat:

- Slack API: free
- Gemini 2.0 Flash: ~$0.01-0.05 per brief (well under $2/month)
- Vercel: free tier is enough — one cron + one slash command, both under 5min

## Things to add later (not in v1)

- Per-user DMs with items where they're the named owner
- Slack reactions (`:white_check_mark:`) close out an item so it doesn't reappear tomorrow
- Slack Canvas integration for a persistent rolling action item list
- Web dashboard for editing channel mapping without redeploying
- Plug into your CRM / issue tracker so customer names get linked to deal stage
