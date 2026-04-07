import type { VercelRequest, VercelResponse } from "@vercel/node";
import { runBrief } from "../../lib/runBrief.js";

/**
 * Vercel Cron entrypoint.
 *
 * Schedule (vercel.json): "30 4 * * 1-5"  →  04:30 UTC = 10:00 IST, Mon-Fri.
 * That gives us 30 minutes of buffer before standup at 10:30 IST.
 *
 * Vercel Cron requests are signed: incoming requests carry an
 * `Authorization: Bearer <CRON_SECRET>` header where CRON_SECRET is the
 * project env var Vercel auto-injects. We verify it to prevent random hits.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers["authorization"];
    const querySecret = req.query?.secret;
    const validHeader = authHeader === `Bearer ${cronSecret}`;
    const validQuery = querySecret === cronSecret;
    if (!validHeader && !validQuery) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  try {
    const result = await runBrief();
    return res.status(200).json({
      ok: true,
      posted: result.posted,
      groups: result.digests.length,
      total_messages: result.digests.reduce((s, d) => s + d.message_count, 0),
    });
  } catch (e: any) {
    console.error("[cron] standup-brief failed", e);
    return res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
}
