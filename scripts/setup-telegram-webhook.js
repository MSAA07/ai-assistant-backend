import dotenv from "dotenv";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { validateTelegramEnv } from "../utils/telegramDelivery.js";
import { redactTelegramText } from "../utils/telegramNotify.js";

dotenv.config();

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const envCheck = validateTelegramEnv(process.env, { requireWebhookUrl: true });
if (!envCheck.ok) {
  if (envCheck.missing.includes("TELEGRAM_WEBHOOK_URL")) {
    fail("ERROR: TELEGRAM_WEBHOOK_URL is not set. Set it in your .env before running this script.");
  }

  fail(`Telegram webhook setup missing environment: ${envCheck.missing.join(", ")}`);
}

const webhookUrl = normalizeString(process.env.TELEGRAM_WEBHOOK_URL);

if (!webhookUrl) {
  fail("ERROR: TELEGRAM_WEBHOOK_URL is not set. Set it in your .env before running this script.");
}

console.log(`About to register Telegram webhook URL: ${webhookUrl}`);

const rl = createInterface({ input, output });
const confirmation = await rl.question("Continue? Type yes to register this webhook: ");
rl.close();

if (confirmation.trim().toLowerCase() !== "yes") {
  fail("Telegram webhook registration cancelled.");
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
