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
  assert.match(body.text, /🚨 StudyMaxing Admin Alert/);
  assert.match(body.text, /Environment: test/);
  assert.match(body.text, /Event: Generation failed permanently/);
  assert.match(body.text, /Severity: critical/);
  assert.match(body.text, /User: user_1/);
  assert.match(body.text, /Document: doc_1/);
  assert.match(body.text, /Job: job_1/);
  assert.match(body.text, /Generation: summary/);
  assert.match(body.text, /Details: n\/a/);
  assert.match(body.text, /Time: /);
  assert.match(body.text, /Action: Check worker logs, model\/provider response, and generation inputs\./);
  assert.doesNotMatch(body.text, /abc123/);
  assert.doesNotMatch(body.text, /supersecret/);
});

test("sendTelegramAdminNotification formats new user signup safely", async () => {
  const calls = [];
  const result = await sendTelegramAdminNotification({
    eventType: "new_user_signup",
    user: { id: "user_2", email: "new@example.com" },
    timestamp: "2026-04-30T12:00:00.000Z",
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

  const body = JSON.parse(calls[0].options.body);
  assert.match(body.text, /Event: New user signup/);
  assert.match(body.text, /Severity: info/);
  assert.match(body.text, /User: user_2 \/ new@example\.com/);
  assert.match(body.text, /Document: n\/a/);
  assert.match(body.text, /Job: n\/a/);
  assert.match(body.text, /Generation: n\/a/);
  assert.match(body.text, /Details: n\/a/);
  assert.match(body.text, /Error: n\/a/);
  assert.match(body.text, /Time: 2026-04-30T12:00:00\.000Z/);
  assert.match(body.text, /Action: Review user activity if needed\./);
  assert.doesNotMatch(body.text, /password/i);
  assert.doesNotMatch(body.text, /cookie/i);
  assert.doesNotMatch(body.text, /session/i);
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
  const redacted = redactTelegramText(`cookie=sessionid token=abc password=hunter2 generated content: private ${"x".repeat(500)}`);

  assert.doesNotMatch(redacted, /sessionid/);
  assert.doesNotMatch(redacted, /abc/);
  assert.doesNotMatch(redacted, /hunter2/);
  assert.doesNotMatch(redacted, /private/);
  assert.ok(redacted.length <= 240);
});
