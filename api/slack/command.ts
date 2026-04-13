import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "node:crypto";
import { runBrief } from "../../lib/runBrief.js";

/**
 * Slash command handler — wired to `/standup-brief` in your Slack app.
 *
 * Slack expects a 200 response within 3 seconds. The brief takes much longer
 * (Slack API + Gemini calls), so we ack immediately with an in-channel
 * "working on it" message and run the real job in the background.
 */
export const config = { api: { bodyParser: false } };

async function readRawBody(req: VercelRequest): Promise<string> {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function verifySlackSignature(req: VercelRequest, raw: string): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return false;
  const ts = req.headers["x-slack-request-timestamp"] as string;
  const sig = req.headers["x-slack-signature"] as string;
  if (!ts || !sig) return false;
  // Reject anything older than 5 min (replay protection).
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) return false;
  const base = `v0:${ts}:${raw}`;
  const expected =
    "v0=" + crypto.createHmac("sha256", secret).update(base).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();

  let raw = "";
  let responseUrl = "";

  try {
    raw = await readRawBody(req);
    const params = new URLSearchParams(raw);
    responseUrl = params.get("response_url") ?? "";

    if (!verifySlackSignature(req, raw)) {
      const reason = !process.env.SLACK_SIGNING_SECRET
        ? "SLACK_SIGNING_SECRET env var is not set"
        : "signature mismatch — check that SLACK_SIGNING_SECRET matches your Slack app";
      console.error("[command] signature verification failed:", reason);
      return res.status(200).json({
        response_type: "ephemeral",
        text: `:x: Auth failed: ${reason}`,
      });
    }

    // Ack immediately so Slack doesn't time out.
    res.status(200).json({
      response_type: "ephemeral",
      text: ":hourglass_flowing_sand: Generating standup brief — this takes 30-90s. I'll post it to the channel when ready.",
    });

    runBrief().catch(async (e) => {
      console.error("[command] runBrief failed", e);
      if (responseUrl) {
        await fetch(responseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            response_type: "ephemeral",
            text: `:x: Brief failed: ${e?.message ?? String(e)}`,
          }),
        }).catch(() => {});
      }
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[command] handler error", msg);
    if (!res.headersSent) {
      res.status(200).json({
        response_type: "ephemeral",
        text: `:x: Internal error: ${msg}`,
      });
    }
  }
}
