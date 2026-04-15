import type { VercelRequest, VercelResponse } from "@vercel/node";
import { runBrief } from "../../lib/runBrief.js";

/**
 * Vercel Cron entrypoint — late fallback only.
 *
 * Primary trigger: GitHub Actions (.github/workflows/standup-brief.yml)
 * fires at 05:00 UTC (10:30 IST) with ~1-5 min jitter.
 *
 * Vercel cron (vercel.json): "0 7 * * 1-5" = 07:00 UTC = 12:30 IST.
 * Only runs if GitHub Actions failed. runBrief() checks for a prior post
 * and skips automatically, so there's no risk of double-posting.
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
