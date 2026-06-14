import assert from "node:assert/strict";
import test from "node:test";

import {
  __telegramDeliveryTestables,
  createTelegramDeepLink,
  createTelegramLinkToken,
  validateTelegramEnv,
} from "./telegramDelivery.js";

test("Telegram env validation reports missing runtime secrets", () => {
  const result = validateTelegramEnv({}, { requireWebhookUrl: true });

  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, [
    "TELEGRAM_BOT_USERNAME",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_WEBHOOK_SECRET",
    "TELEGRAM_WEBHOOK_URL",
  ]);
});

test("Telegram link tokens are URL-safe and do not expose user ids", () => {
  const token = createTelegramLinkToken();
  const deepLink = createTelegramDeepLink("studymaxing_admin_bot", token);

  assert.match(token, /^[A-Za-z0-9_-]{40,64}$/);
  assert.equal(deepLink, `https://t.me/studymaxing_admin_bot?start=${token}`);
  assert.equal(deepLink.includes("user_"), false);
});

test("Telegram quiz poll eligibility enforces Telegram limits and answer mapping", () => {
  const question = {
    questionType: "mcq",
    question: "Which option is correct?",
    options: ["Alpha", "Beta", "Gamma"],
    correctAnswer: "Beta",
  };
  const options = __telegramDeliveryTestables.getQuestionOptions(question);
  const correctIndex = __telegramDeliveryTestables.getCorrectOptionIndex(question, options);

  assert.equal(correctIndex, 1);
  assert.equal(__telegramDeliveryTestables.canSendQuestionAsQuizPoll(question, options, correctIndex), true);

  const longQuestion = { ...question, question: "x".repeat(301) };
  assert.equal(__telegramDeliveryTestables.canSendQuestionAsQuizPoll(longQuestion, options, correctIndex), false);
});

test("Telegram formatting preserves answer mapping for formula options", () => {
  const question = {
    questionType: "mcq",
    question: "Which formula is water?",
    options: ["CO2", "H2O", "O2"],
    correctAnswer: "H2O",
  };
  const options = __telegramDeliveryTestables.getQuestionOptions(question);
  const correctIndex = __telegramDeliveryTestables.getCorrectOptionIndex(question, options);

  assert.deepEqual(options, ["CO₂", "H₂O", "O₂"]);
  assert.equal(correctIndex, 1);
});
