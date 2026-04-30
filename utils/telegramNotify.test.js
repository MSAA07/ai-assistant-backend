import assert from "node:assert/strict";
import test from "node:test";

import {
  redactTelegramText,
  sendTelegramAdminNotification,
} from "./telegramNotify.js";

test("sendTelegramAdminNotification no-ops when Telegram env is missing", async () => {
  const result = await sendTelegramAdminNotification({
    eventType: "test",
    env: {},
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    },
  });

  assert.equal(result.status, "disabled");
});

test("sendTelegramAdminNotification sends safe structured message", async () => {
  const calls = [];
  const result = await sendTelegramAdminNotification({
    eventType: "generation_permanent_failure",
    userId: "user_1",
    documentId: "doc_1",
    jobId: "job_1",
    generationType: "summary",
    error: new Error("Authorization: Bearer abc123 password=supersecret"),
    env: {
      TELEGRAM_BOT_TOKEN: "bot_token",
      TELEGRAM_ADMIN_CHAT_ID: "chat_1",
      NODE_ENV: "test",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200 };
    },
  });

  assert.equal(result.status, "sent");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.telegram.org/botbot_token/sendMessage");

  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.chat_id, "chat_1");
  assert.match(body.text, /Environment: test/);
  assert.match(body.text, /Event: generation_permanent_failure/);
  assert.match(body.text, /User: user_1/);
  assert.match(body.text, /Document: doc_1/);
  assert.match(body.text, /Job: job_1/);
  assert.match(body.text, /Generation: summary/);
  assert.doesNotMatch(body.text, /abc123/);
  assert.doesNotMatch(body.text, /supersecret/);
});

test("sendTelegramAdminNotification swallows Telegram failures", async () => {
  const result = await sendTelegramAdminNotification({
    eventType: "test",
    errorSummary: "safe error",
    env: {
      TELEGRAM_BOT_TOKEN: "bot_token",
      TELEGRAM_ADMIN_CHAT_ID: "chat_1",
      NODE_ENV: "test",
    },
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      async text() {
        return "token=secret";
      },
    }),
  });

  assert.equal(result.status, "failed");
});

test("redactTelegramText removes sensitive labels and truncates text", () => {
  const redacted = redactTelegramText(`cookie=sessionid token=abc password=hunter2 ${"x".repeat(500)}`);

  assert.doesNotMatch(redacted, /sessionid/);
  assert.doesNotMatch(redacted, /abc/);
  assert.doesNotMatch(redacted, /hunter2/);
  assert.ok(redacted.length <= 240);
});
