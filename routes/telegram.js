import { timingSafeEqual } from "crypto";
import express from "express";

import { createRateLimiter } from "../middleware/rateLimit.js";
import { DOCUMENT_PROCESSING_STATUS, normalizeDocumentProcessingStatus } from "../utils/documentStatus.js";
import { captureSentryException } from "../utils/sentry.js";
import {
  TELEGRAM_DELIVERY_STATUS,
  TELEGRAM_DELIVERY_TYPES,
  TELEGRAM_LINK_TOKEN_TTL_MS,
  TELEGRAM_SEND_COOLDOWN_MS,
  TelegramDeliveryError,
  callTelegramApi,
  createTelegramDeepLink,
  createTelegramLinkToken,
  getTelegramBotUsername,
  sendExamToTelegram,
  sendFlashcardsToTelegram,
  validateTelegramEnv,
} from "../utils/telegramDelivery.js";
import { redactTelegramText } from "../utils/telegramNotify.js";
import { createHttpError } from "../utils/routeHelpers.js";

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function jsonError(res, error, fallbackMessage) {
  const statusCode = error?.statusCode || 500;
  const payload = {
    error: statusCode >= 500 ? fallbackMessage : error?.message || fallbackMessage,
  };
  if (error?.code) {
    payload.code = error.code;
  }
  return res.status(statusCode).json(payload);
}

function asTelegramId(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function safeEquals(left = "", right = "") {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length
    && leftBuffer.length > 0
    && cryptoSafeTimingEqual(leftBuffer, rightBuffer);
}

function cryptoSafeTimingEqual(leftBuffer, rightBuffer) {
  try {
    return timingSafeEqual(leftBuffer, rightBuffer);
  } catch {
    return false;
  }
}

function getWebhookSecretHeader(req) {
  const value = req.get("x-telegram-bot-api-secret-token");
  return Array.isArray(value) ? value[0] : value;
}

function validateWebhookSecret(req, env) {
  const expected = normalizeString(env.TELEGRAM_WEBHOOK_SECRET);
  if (!expected) {
    return false;
  }

  return safeEquals(getWebhookSecretHeader(req), expected);
}

function parseStartPayload(update = {}) {
  const message = update.message ?? update.edited_message ?? null;
  const text = normalizeString(message?.text);
  if (!message || !text) {
    return { message, token: "" };
  }

  const match = text.match(/^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{16,64}))?\s*$/);
  return {
    message,
    token: match?.[1] ?? "",
  };
}

function serializeConnectionStatus({ connection, lastSend, botUsername }) {
  const connected = Boolean(connection && !connection.disconnectedAt);
  return {
    connected,
    botUsername,
    connectedAt: connected ? connection.connectedAt ?? null : null,
    lastSendAt: lastSend?.sentAt ?? null,
  };
}

async function getTelegramStatus(prisma, userId, env) {
  const [connection, lastSend] = await Promise.all([
    prisma.telegramConnection.findUnique({
      where: { userId },
    }),
    prisma.telegramDeliveryLog.findFirst({
      where: {
        userId,
        status: TELEGRAM_DELIVERY_STATUS.sent,
        sentAt: { not: null },
      },
      orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
      select: { sentAt: true },
    }),
  ]);

  return serializeConnectionStatus({
    connection,
    lastSend,
    botUsername: getTelegramBotUsername(env),
  });
}

async function getOwnedReadyDocument(prisma, documentId, userId) {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      userId: true,
      originalName: true,
      filename: true,
      processingStatus: true,
      processingError: true,
      processedAt: true,
    },
  });

  if (!document) {
    throw createHttpError(404, "Document not found", "document_not_found");
  }

  if (document.userId !== userId) {
    throw createHttpError(403, "Access denied", "forbidden");
  }

  if (normalizeDocumentProcessingStatus(document.processingStatus) !== DOCUMENT_PROCESSING_STATUS.complete) {
    throw createHttpError(409, "Document processing is not complete", "document_not_ready");
  }

  return document;
}

async function getConnectedTelegramConnection(prisma, userId) {
  const connection = await prisma.telegramConnection.findUnique({
    where: { userId },
  });

  if (!connection || connection.disconnectedAt) {
    throw createHttpError(409, "Connect Telegram before sending study materials", "telegram_not_connected");
  }

  return connection;
}

async function assertSendCooldown(prisma, { userId, documentId, type, now = new Date() }) {
  const cooldownSince = new Date(now.getTime() - TELEGRAM_SEND_COOLDOWN_MS);
  const recent = await prisma.telegramDeliveryLog.findFirst({
    where: {
      userId,
      documentId,
      type,
      status: TELEGRAM_DELIVERY_STATUS.sent,
      createdAt: { gte: cooldownSince },
    },
    select: { id: true },
  });

  if (recent) {
    throw createHttpError(
      429,
      "Telegram send was just requested. Wait a few seconds and try again.",
      "telegram_send_cooldown",
    );
  }
}

async function getLatestFlashcards(prisma, documentId) {
  const set = await prisma.flashcardSet.findFirst({
    where: {
      documentId,
      isLatest: true,
    },
    orderBy: [{ createdAt: "desc" }],
    include: {
      cards: {
        where: { isDeleted: false },
        orderBy: [{ position: "asc" }],
      },
    },
  });

  if (!set || !Array.isArray(set.cards) || set.cards.length === 0) {
    throw createHttpError(409, "Flashcards are not ready", "flashcards_not_ready");
  }

  return set.cards;
}

async function getLatestExamQuestions(prisma, documentId) {
  const record = await prisma.examRecord.findFirst({
    where: {
      documentId,
      isLatest: true,
    },
    orderBy: [{ createdAt: "desc" }],
    include: {
      questions: {
        orderBy: [{ position: "asc" }],
      },
    },
  });

  if (!record || !Array.isArray(record.questions) || record.questions.length === 0) {
    throw createHttpError(409, "Exam is not ready", "exam_not_ready");
  }

  return record.questions;
}

function sanitizeDeliveryError(error) {
  return redactTelegramText(error?.message || "Telegram delivery failed").slice(0, 1000);
}

async function recordDeliveryFailure(prisma, { userId, documentId, type, itemCount, error }) {
  return prisma.telegramDeliveryLog.create({
    data: {
      userId,
      documentId,
      type,
      status: TELEGRAM_DELIVERY_STATUS.failed,
      itemCount,
      errorMessage: sanitizeDeliveryError(error),
      sentAt: null,
    },
  });
}

async function sendTelegramConfirmation(chatId, text, options) {
  if (!chatId || !text) return;
  try {
    await callTelegramApi("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }, options);
  } catch (error) {
    console.error("[telegram] failed to send webhook confirmation:", {
      error: sanitizeDeliveryError(error),
    });
  }
}

async function linkTelegramAccount({ prisma, token, message }) {
  const chatId = asTelegramId(message?.chat?.id);
  const telegramUserId = asTelegramId(message?.from?.id);
  const telegramUsername = normalizeString(message?.from?.username) || null;
  const chatType = normalizeString(message?.chat?.type).toLowerCase();

  if (!chatId || !telegramUserId) {
    throw createHttpError(400, "Telegram chat information is missing", "telegram_chat_missing");
  }

  if (chatType && chatType !== "private") {
    throw createHttpError(400, "Open the StudyMaxing bot in a private Telegram chat to connect your account.", "telegram_private_chat_required");
  }

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const linkToken = await tx.telegramLinkToken.findUnique({
      where: { token },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        usedAt: true,
      },
    });

    if (!linkToken || linkToken.usedAt || linkToken.expiresAt <= now) {
      throw createHttpError(400, "This Telegram link is invalid or expired", "telegram_token_invalid");
    }

    const consumed = await tx.telegramLinkToken.updateMany({
      where: {
        id: linkToken.id,
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    });

    if (consumed.count !== 1) {
      throw createHttpError(400, "This Telegram link is invalid or expired", "telegram_token_invalid");
    }

    await tx.telegramConnection.upsert({
      where: { userId: linkToken.userId },
      update: {
        telegramUserId,
        telegramChatId: chatId,
        telegramUsername,
        connectedAt: now,
        disconnectedAt: null,
      },
      create: {
        userId: linkToken.userId,
        telegramUserId,
        telegramChatId: chatId,
        telegramUsername,
        connectedAt: now,
      },
    });

    return { userId: linkToken.userId, chatId };
  });
}

async function handleWebhookUpdate({ prisma, update, env, fetchImpl }) {
  const { message, token } = parseStartPayload(update);
  if (!message) {
    return { handled: false };
  }

  const chatId = asTelegramId(message.chat?.id);
  const text = normalizeString(message.text);
  if (!text.startsWith("/start")) {
    return { handled: false };
  }

  if (!token) {
    await sendTelegramConfirmation(
      chatId,
      "Open Telegram from StudyMaxing to connect this bot to your account.",
      { env, fetchImpl },
    );
    return { handled: true };
  }

  try {
    await linkTelegramAccount({ prisma, token, message });
    await sendTelegramConfirmation(
      chatId,
      "Telegram is connected to your StudyMaxing account. Return to StudyMaxing and refresh Telegram status.",
      { env, fetchImpl },
    );
  } catch (error) {
    await sendTelegramConfirmation(
      chatId,
      error?.code === "telegram_private_chat_required"
        ? error.message
        : "This StudyMaxing Telegram link is invalid or expired. Create a new link from StudyMaxing and try again.",
      { env, fetchImpl },
    );
    throw error;
  }

  return { handled: true };
}

export const createTelegramRouter = ({
  prisma,
  requireAuth,
  env = process.env,
  fetchImpl = globalThis.fetch,
  pacingMs,
} = {}) => {
  const router = express.Router();
  const linkTokenLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 10,
    keyGenerator: (req) => req.session?.user?.id || req.ip || "unknown",
  });
  const sendLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 5,
    keyGenerator: (req) => `${req.session?.user?.id || req.ip || "unknown"}:${req.path}`,
  });

  router.post("/telegram/webhook", async (req, res) => {
    if (!validateWebhookSecret(req, env)) {
      return res.status(401).json({ error: "Invalid Telegram webhook secret" });
    }

    try {
      await handleWebhookUpdate({ prisma, update: req.body, env, fetchImpl });
      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error("[telegram] webhook processing failed:", {
        error: sanitizeDeliveryError(error),
      });
      captureSentryException(error, {
        tags: { route: "telegram", action: "webhook" },
      });
      return res.status(200).json({ ok: true });
    }
  });

  router.get("/telegram/status", requireAuth, async (req, res) => {
    try {
      const status = await getTelegramStatus(prisma, req.session.user.id, env);
      return res.json(status);
    } catch (error) {
      console.error("[telegram] status failed:", error);
      captureSentryException(error, {
        tags: { route: "telegram", action: "status" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
      });
      return jsonError(res, error, "Failed to load Telegram status");
    }
  });

  router.post("/telegram/link-token", requireAuth, linkTokenLimiter, async (req, res) => {
    try {
      const config = validateTelegramEnv(env);
      if (!config.ok) {
        throw createHttpError(503, "Telegram is not configured", "telegram_not_configured");
      }

      const token = createTelegramLinkToken();
      const expiresAt = new Date(Date.now() + TELEGRAM_LINK_TOKEN_TTL_MS);
      await prisma.telegramLinkToken.create({
        data: {
          token,
          userId: req.session.user.id,
          expiresAt,
        },
      });

      return res.status(201).json({
        botUsername: config.botUsername,
        deepLink: createTelegramDeepLink(config.botUsername, token),
        expiresAt,
      });
    } catch (error) {
      console.error("[telegram] link token creation failed:", {
        error: sanitizeDeliveryError(error),
      });
      captureSentryException(error, {
        tags: { route: "telegram", action: "link_token" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
      });
      return jsonError(res, error, "Failed to create Telegram link");
    }
  });

  router.delete("/telegram/link", requireAuth, async (req, res) => {
    try {
      await prisma.telegramConnection.updateMany({
        where: {
          userId: req.session.user.id,
          disconnectedAt: null,
        },
        data: {
          disconnectedAt: new Date(),
        },
      });

      return res.json({ success: true });
    } catch (error) {
      console.error("[telegram] disconnect failed:", {
        error: sanitizeDeliveryError(error),
      });
      captureSentryException(error, {
        tags: { route: "telegram", action: "disconnect" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
      });
      return jsonError(res, error, "Failed to disconnect Telegram");
    }
  });

  async function sendStudyMaterials(req, res, type) {
    const userId = req.session.user.id;
    const documentId = req.params.id;
    const sentAt = new Date();
    let itemCount = 0;

    try {
      const config = validateTelegramEnv(env);
      if (!config.ok) {
        throw createHttpError(503, "Telegram is not configured", "telegram_not_configured");
      }

      const [document, connection] = await Promise.all([
        getOwnedReadyDocument(prisma, documentId, userId),
        getConnectedTelegramConnection(prisma, userId),
      ]);
      await assertSendCooldown(prisma, { userId, documentId, type, now: sentAt });

      if (type === TELEGRAM_DELIVERY_TYPES.flashcards) {
        const cards = await getLatestFlashcards(prisma, documentId);
        itemCount = cards.length;
        const result = await sendFlashcardsToTelegram({
          chatId: connection.telegramChatId,
          document,
          cards,
          env,
          fetchImpl,
          pacingMs,
        });
        itemCount = result.itemCount;
      } else {
        const questions = await getLatestExamQuestions(prisma, documentId);
        itemCount = questions.length;
        const result = await sendExamToTelegram({
          chatId: connection.telegramChatId,
          document,
          questions,
          env,
          fetchImpl,
          pacingMs,
        });
        itemCount = result.itemCount;
      }

      await prisma.telegramDeliveryLog.create({
        data: {
          userId,
          documentId,
          type,
          status: TELEGRAM_DELIVERY_STATUS.sent,
          itemCount,
          sentAt,
        },
      });

      return res.json({
        success: true,
        type,
        itemCount,
        sentAt,
      });
    } catch (error) {
      if (error instanceof TelegramDeliveryError) {
        await recordDeliveryFailure(prisma, {
          userId,
          documentId,
          type,
          itemCount,
          error,
        }).catch((logError) => {
          console.error("[telegram] failed to record delivery failure:", {
            error: sanitizeDeliveryError(logError),
          });
        });
      }

      console.error("[telegram] send failed:", {
        type,
        documentId,
        userId,
        error: sanitizeDeliveryError(error),
      });
      captureSentryException(error, {
        tags: { route: "telegram", action: `send_${type}` },
        user: { id: userId },
        extra: { documentId, type },
      });
      return jsonError(res, error, `Failed to send ${type} to Telegram`);
    }
  }

  router.post("/document/:id/telegram/flashcards/send", requireAuth, sendLimiter, (req, res) => {
    return sendStudyMaterials(req, res, TELEGRAM_DELIVERY_TYPES.flashcards);
  });

  router.post("/document/:id/telegram/exam/send", requireAuth, sendLimiter, (req, res) => {
    return sendStudyMaterials(req, res, TELEGRAM_DELIVERY_TYPES.exam);
  });

  return router;
};

export const __telegramRouteTestables = {
  parseStartPayload,
  serializeConnectionStatus,
  validateWebhookSecret,
  linkTelegramAccount,
  handleWebhookUpdate,
};
