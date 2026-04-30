import dotenv from "dotenv";

import { runDailyAdminDigestScript } from "../utils/adminDigest.js";

dotenv.config();

const dryRun = process.argv.includes("--dry-run");

await runDailyAdminDigestScript({ dryRun });
