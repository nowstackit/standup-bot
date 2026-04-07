import { runBrief } from "../lib/runBrief.js";

// Local test runner. Usage:
//   SLACK_BOT_TOKEN=xoxb-... GEMINI_API_KEY=... npx tsx scripts/run-local.ts
//   SLACK_BOT_TOKEN=xoxb-... GEMINI_API_KEY=... DRY_RUN=1 npx tsx scripts/run-local.ts
const dry = process.env.DRY_RUN === "1";
runBrief({ dryRun: dry })
  .then((r) => {
    console.log("done. posted=", r.posted, "groups=", r.digests.length);
    if (dry) {
      console.log("\n--- Block Kit preview ---");
      console.log(JSON.stringify(r.blocks, null, 2));
    }
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
