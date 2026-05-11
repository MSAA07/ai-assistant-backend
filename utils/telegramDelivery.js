import crypto from "crypto";

import { redactTelegramText } from "./telegramNotify.js";

export const TELEGRAM_DELIVERY_TYPES = Object.freeze({
  flashcards: "flashcards",
  exam: "exam",
});

export const TELEGRAM_DELIVERY_STATUS = Object.freeze({
  sent: "sent",
  failed: "failed",
});

export const TELEGRAM_LINK_TOKEN_TTL_MS = 10 * 60 * 1000;
export const TELEGRAM_SEND_COOLDOWN_MS = 15 * 1000;

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_SAFE_MESSAGE_LIMIT = 3900;
const TELEGRAM_POLL_QUESTION_LIMIT = 300;
const TELEGRAM_POLL_OPTION_LIMIT = 100;
const TELEGRAM_POLL_EXPLANATION_LIMIT = 200;
const TELEGRAM_POLL_MAX_OPTIONS = 10;
const DEFAULT_SEND_TIMEOUT_MS = 10_000;
const DEFAULT_MESSAGE_PACING_MS = 120;

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asTelegramId(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

export function normalizeTelegramBotUsername(value) {
  return normalizeString(value).replace(/^@+/, "");
}

export function getTelegramBotUsername(env = process.env) {
  return normalizeTelegramBotUsername(env.TELEGRAM_BOT_USERNAME || "studymaxing_admin_bot");
}

export function validateTelegramEnv(env = process.env, { requireWebhookUrl = false } = {}) {
  const missing = [];
  if (!normalizeTelegramBotUsername(env.TELEGRAM_BOT_USERNAME)) missing.push("TELEGRAM_BOT_USERNAME");
  if (!normalizeString(env.TELEGRAM_BOT_TOKEN)) missing.push("TELEGRAM_BOT_TOKEN");
  if (!normalizeString(env.TELEGRAM_WEBHOOK_SECRET)) missing.push("TELEGRAM_WEBHOOK_SECRET");
  if (requireWebhookUrl && !normalizeString(env.TELEGRAM_WEBHOOK_URL)) {
    missing.push("TELEGRAM_WEBHOOK_URL");
  }

  return {
    ok: missing.length === 0,
    missing,
    botUsername: getTelegramBotUsername(env),
  };
}

export function createTelegramLinkToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function createTelegramDeepLink(botUsername, token) {
  const username = normalizeTelegramBotUsername(botUsername);
  if (!username || !normalizeString(token)) {
    return "";
  }

  return `https://t.me/${username}?start=${encodeURIComponent(token)}`;
}

function truncateTelegramField(value, maxLength) {
  const text = normalizeString(value);
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 14)).trimEnd()}...`;
}

function splitTelegramMessage(text, limit = TELEGRAM_SAFE_MESSAGE_LIMIT) {
  const source = normalizeString(text);
  if (!source) return [];
  if (source.length <= TELEGRAM_MESSAGE_LIMIT) {
    return [source];
  }

  const chunks = [];
  let remaining = source;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const paragraphBreak = window.lastIndexOf("\n\n");
    const lineBreak = window.lastIndexOf("\n");
    const space = window.lastIndexOf(" ");
    const splitAt = paragraphBreak > limit * 0.55
      ? paragraphBreak
      : lineBreak > limit * 0.55
        ? lineBreak
        : space > limit * 0.55
          ? space
          : limit;

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

async function sleep(ms) {
  if (!ms) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error) {
  if (error instanceof Error) {
    return redactTelegramText(error.message || error.name);
  }

  return redactTelegramText(error);
}

export class TelegramDeliveryError extends Error {
  constructor(message, { statusCode = 502, cause } = {}) {
    super(message);
    this.name = "TelegramDeliveryError";
    this.statusCode = statusCode;
    this.cause = cause;
  }
}

export async function callTelegramApi(method, payload, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_SEND_TIMEOUT_MS,
} = {}) {
  const botToken = normalizeString(env.TELEGRAM_BOT_TOKEN);
  if (!botToken) {
    throw new TelegramDeliveryError("Telegram bot token is not configured.", { statusCode: 503 });
  }

  if (typeof fetchImpl !== "function") {
    throw new TelegramDeliveryError("Telegram fetch runtime is unavailable.", { statusCode: 503 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const data = await response.json().catch(async () => {
      const body = typeof response.text === "function" ? await response.text() : "";
      return body ? { description: body } : null;
    });

    if (!response.ok || data?.ok === false) {
      const description = redactTelegramText(data?.description || data?.error || "");
      const suffix = description ? `: ${description}` : "";
      throw new TelegramDeliveryError(`Telegram ${method} failed${suffix}`, {
        statusCode: response.status || 502,
      });
    }

    return data;
  } catch (error) {
    if (error instanceof TelegramDeliveryError) {
      throw error;
    }

    const message = error?.name === "AbortError"
      ? `Telegram ${method} timed out`
      : `Telegram ${method} request failed: ${getErrorMessage(error)}`;
    throw new TelegramDeliveryError(message, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

async function sendMessage(chatId, text, options = {}) {
  return callTelegramApi("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  }, options);
}

async function sendLongMessage(chatId, text, options = {}) {
  const chunks = splitTelegramMessage(text);
  for (let index = 0; index < chunks.length; index += 1) {
    const prefix = index === 0 ? "" : `(continued ${index + 1}/${chunks.length})\n\n`;
    await sendMessage(chatId, `${prefix}${chunks[index]}`, options);
    if (index < chunks.length - 1) {
      await sleep(options.pacingMs ?? DEFAULT_MESSAGE_PACING_MS);
    }
  }
}

function normalizeComparableAnswer(value, questionType) {
  const normalized = normalizeString(value).toLowerCase();
  if (questionType === "true_false") {
    if (normalized === "true" || normalized === "t") return "true";
    if (normalized === "false" || normalized === "f") return "false";
  }
  return normalized;
}

function getQuestionType(question) {
  const type = normalizeString(question?.questionType ?? question?.type).toLowerCase();
  if (type === "true_false" || type === "truefalse") return "true_false";
  return "mcq";
}

function getQuestionOptions(question) {
  const type = getQuestionType(question);
  const options = Array.isArray(question?.options)
    ? question.options.map(normalizeString).filter(Boolean)
    : [];

  if (type === "true_false" && options.length === 0) {
    return ["True", "False"];
  }

  return options;
}

function getCorrectOptionIndex(question, options) {
  const type = getQuestionType(question);
  const correctAnswer = normalizeComparableAnswer(question?.correctAnswer, type);
  if (!correctAnswer) return -1;

  return options.findIndex((option) => (
    normalizeComparableAnswer(option, type) === correctAnswer
  ));
}

function canSendQuestionAsQuizPoll(question, options, correctOptionIndex) {
  const prompt = normalizeString(question?.question);
  return prompt.length > 0
    && prompt.length <= TELEGRAM_POLL_QUESTION_LIMIT
    && options.length >= 2
    && options.length <= TELEGRAM_POLL_MAX_OPTIONS
    && options.every((option) => option.length > 0 && option.length <= TELEGRAM_POLL_OPTION_LIMIT)
    && correctOptionIndex >= 0;
}

function formatDocumentTitle(document) {
  return normalizeString(document?.displayName)
    || normalizeString(document?.originalName)
    || normalizeString(document?.title)
    || "StudyMaxing document";
}

function formatFlashcardMessage({ documentTitle, card, index, total }) {
  const parts = [
    documentTitle,
    "",
    `Card ${index + 1} of ${total}`,
    "",
    "Front:",
    normalizeString(card?.question ?? card?.front),
    "",
    "Back:",
    normalizeString(card?.answer ?? card?.back),
  ];

  const explanation = normalizeString(card?.explanation);
  if (explanation) {
    parts.push("", "Explanation:", explanation);
  }

  return parts.join("\n");
}

function formatExamQuestionMessage({ documentTitle, question, index, total, options }) {
  const optionLines = options.map((option, optionIndex) => (
    `${String.fromCharCode(65 + optionIndex)}. ${option}`
  ));
  const parts = [
    documentTitle,
    "",
    `Question ${index + 1} of ${total}`,
    "",
    normalizeString(question?.question),
  ];

  if (optionLines.length) {
    parts.push("", "Options:", ...optionLines);
  }

  const correctAnswer = normalizeString(question?.correctAnswer);
  if (correctAnswer) {
    parts.push("", `Correct answer: ${correctAnswer}`);
  }

  const explanation = normalizeString(question?.explanation);
  if (explanation) {
    parts.push("", "Explanation:", explanation);
  }

  return parts.join("\n");
}

export async function sendFlashcardsToTelegram({
  chatId,
  document,
  cards = [],
  env = process.env,
  fetchImpl = globalThis.fetch,
  pacingMs = DEFAULT_MESSAGE_PACING_MS,
} = {}) {
  const resolvedChatId = asTelegramId(chatId);
  if (!resolvedChatId) {
    throw new TelegramDeliveryError("Telegram chat is not connected.", { statusCode: 409 });
  }

  const usableCards = cards.filter((card) => normalizeString(card?.question ?? card?.front) && normalizeString(card?.answer ?? card?.back));
  if (usableCards.length === 0) {
    throw new TelegramDeliveryError("Flashcards are not ready.", { statusCode: 409 });
  }

  const documentTitle = formatDocumentTitle(document);
  const options = { env, fetchImpl, pacingMs };
  await sendMessage(resolvedChatId, `Sending ${usableCards.length} flashcards from ${documentTitle}.`, options);
  await sleep(pacingMs);

  for (let index = 0; index < usableCards.length; index += 1) {
    await sendLongMessage(
      resolvedChatId,
      formatFlashcardMessage({ documentTitle, card: usableCards[index], index, total: usableCards.length }),
      options,
    );
    await sleep(pacingMs);
  }

  await sendMessage(resolvedChatId, `All ${usableCards.length} flashcards sent.`, options);

  return { itemCount: usableCards.length };
}

export async function sendExamToTelegram({
  chatId,
  document,
  questions = [],
  env = process.env,
  fetchImpl = globalThis.fetch,
  pacingMs = DEFAULT_MESSAGE_PACING_MS,
} = {}) {
  const resolvedChatId = asTelegramId(chatId);
  if (!resolvedChatId) {
    throw new TelegramDeliveryError("Telegram chat is not connected.", { statusCode: 409 });
  }

  const usableQuestions = questions.filter((question) => normalizeString(question?.question));
  if (usableQuestions.length === 0) {
    throw new TelegramDeliveryError("Exam is not ready.", { statusCode: 409 });
  }

  const documentTitle = formatDocumentTitle(document);
  const options = { env, fetchImpl, pacingMs };
  await sendMessage(resolvedChatId, `Sending ${usableQuestions.length} exam questions from ${documentTitle}.`, options);
  await sleep(pacingMs);

  for (let index = 0; index < usableQuestions.length; index += 1) {
    const question = usableQuestions[index];
    const pollOptions = getQuestionOptions(question);
    const correctOptionIndex = getCorrectOptionIndex(question, pollOptions);

    if (canSendQuestionAsQuizPoll(question, pollOptions, correctOptionIndex)) {
      await callTelegramApi("sendPoll", {
        chat_id: resolvedChatId,
        question: normalizeString(question.question),
        options: pollOptions,
        type: "quiz",
        correct_option_id: correctOptionIndex,
        is_anonymous: true,
        explanation: truncateTelegramField(question.explanation, TELEGRAM_POLL_EXPLANATION_LIMIT) || undefined,
      }, options);
    } else {
      await sendLongMessage(
        resolvedChatId,
        formatExamQuestionMessage({
          documentTitle,
          question,
          index,
          total: usableQuestions.length,
          options: pollOptions,
        }),
        options,
      );
    }

    await sleep(pacingMs);
  }

  await sendMessage(resolvedChatId, `Full exam sent from ${documentTitle}.`, options);

  return { itemCount: usableQuestions.length };
}

export const __telegramDeliveryTestables = {
  splitTelegramMessage,
  canSendQuestionAsQuizPoll,
  getCorrectOptionIndex,
  getQuestionOptions,
  formatFlashcardMessage,
  formatExamQuestionMessage,
};
