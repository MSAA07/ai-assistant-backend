import dotenv from "dotenv";

import { sendTelegramTestAlert } from "../utils/telegramNotify.js";

dotenv.config();

const result = await sendTelegramTestAlert({
  details: "Backend validation script",
});

if (result.status === "sent") {
  console.log("Telegram test alert sent.");
} else if (result.status === "disabled") {
  console.log("Telegram test alert skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID is missing.");
} else {
  console.log("Telegram test alert attempted but was not delivered. Check backend logs for redacted details.");
}
