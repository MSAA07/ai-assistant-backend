import dotenv from "dotenv";

import { validateTelegramEnv } from "../utils/telegramDelivery.js";
import { redactTelegramText } from "../utils/telegramNotify.js";

dotenv.config();

const EXPECTED_STAGING_WEBHOOK_URL = "https://ai-assistant-backend-staging.up.railway.app/api/telegram/webhook";

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const envCheck = validateTelegramEnv(process.env, { requireWebhookUrl: true });
if (!envCheck.ok) {
  fail(`Telegram webhook setup missing environment: ${envCheck.missing.join(", ")}`);
}

const webhookUrl = normalizeString(process.env.TELEGRAM_WEBHOOK_URL);
const allowNonStaging = process.argv.includes("--allow-non-staging");

if (webhookUrl !== EXPECTED_STAGING_WEBHOOK_URL && !allowNonStaging) {
  fail(
    `Refusing to register unexpected webhook URL. Expected ${EXPECTED_STAGING_WEBHOOK_URL}. `
    + "Pass --allow-non-staging only when intentionally configuring another environment.",
  );
}

const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url: webhookUrl,
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message"],
    drop_pending_updates: false,
  }),
});

const data = await response.json().catch(() => null);

if (!response.ok || data?.ok === false) {
  fail(`Telegram webhook registration failed: ${redactTelegramText(data?.description || response.statusText || "unknown error")}`);
}

console.log(`Telegram webhook registered for @${envCheck.botUsername}: ${webhookUrl}`);
