import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import { createTelegramRouter } from "./telegram.js";

const env = {
  TELEGRAM_BOT_USERNAME: "studymaxing_admin_bot",
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_WEBHOOK_SECRET: "test-secret",
};

function createResponse(data = { ok: true, result: {} }, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    },
    async text() {
      return JSON.stringify(data);
    },
  };
}

function createFetchMock() {
  const calls = [];
  const fetchImpl = async (_url, init = {}) => {
    calls.push(JSON.parse(init.body || "{}"));
    return createResponse();
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function createMockPrisma(overrides = {}) {
  const state = {
    documents: [
      { id: "doc_complete", userId: "user_1", originalName: "Biology.pdf", filename: "biology.pdf", processingStatus: "complete" },
      { id: "doc_other", userId: "user_2", originalName: "Other.pdf", filename: "other.pdf", processingStatus: "complete" },
      { id: "doc_processing", userId: "user_1", originalName: "Draft.pdf", filename: "draft.pdf", processingStatus: "processing" },
      { id: "doc_no_cards", userId: "user_1", originalName: "Empty Cards.pdf", filename: "empty.pdf", processingStatus: "complete" },
      { id: "doc_no_exam", userId: "user_1", originalName: "Empty Exam.pdf", filename: "empty-exam.pdf", processingStatus: "complete" },
    ],
    telegramConnections: [],
    telegramLinkTokens: [],
    telegramDeliveryLogs: [],
    flashcardSets: [
      {
        id: "set_1",
        documentId: "doc_complete",
        isLatest: true,
        createdAt: new Date("2026-05-11T00:00:00.000Z"),
        cards: [
          { id: "card_1", position: 0, question: "Cell?", answer: "Basic unit of life.", explanation: null, isDeleted: false },
          { id: "card_2", position: 1, question: "DNA?", answer: "Genetic material.", explanation: null, isDeleted: false },
        ],
      },
    ],
    examRecords: [
      {
        id: "exam_1",
        documentId: "doc_complete",
        isLatest: true,
        createdAt: new Date("2026-05-11T00:00:00.000Z"),
        questions: [
          {
            id: "q_1",
            position: 0,
            questionType: "mcq",
            question: "What stores genetic information?",
            options: ["RNA", "DNA", "ATP"],
            correctAnswer: "DNA",
            explanation: "DNA stores genetic information.",
          },
        ],
      },
    ],
    ...overrides,
  };

  const prisma = {
    state,
    async $transaction(input) {
      if (Array.isArray(input)) {
        return Promise.all(input);
      }
      return input(prisma);
    },
    document: {
      async findUnique({ where }) {
        return state.documents.find((document) => document.id === where.id) ?? null;
      },
    },
    telegramConnection: {
      async findUnique({ where }) {
        return state.telegramConnections.find((connection) => connection.userId === where.userId) ?? null;
      },
      async findMany({ where }) {
        const ids = where?.userId?.in ?? [];
        return state.telegramConnections.filter((connection) => ids.includes(connection.userId));
      },
      async upsert({ where, update, create }) {
        const existing = state.telegramConnections.find((connection) => connection.userId === where.userId);
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date() });
          return existing;
        }
        const created = {
          id: `conn_${state.telegramConnections.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          disconnectedAt: null,
          ...create,
        };
        state.telegramConnections.push(created);
        return created;
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const connection of state.telegramConnections) {
          if (connection.userId === where.userId && connection.disconnectedAt === where.disconnectedAt) {
            Object.assign(connection, data);
            count += 1;
          }
        }
        return { count };
      },
    },
    telegramLinkToken: {
      async create({ data }) {
        const created = {
          id: `token_${state.telegramLinkTokens.length + 1}`,
          createdAt: new Date(),
          usedAt: null,
          ...data,
        };
        state.telegramLinkTokens.push(created);
        return created;
      },
      async findUnique({ where }) {
        return state.telegramLinkTokens.find((token) => token.token === where.token) ?? null;
      },
      async updateMany({ where, data }) {
        const token = state.telegramLinkTokens.find((entry) => entry.id === where.id);
        if (!token || token.usedAt !== null || token.expiresAt <= where.expiresAt.gt) {
          return { count: 0 };
        }
        Object.assign(token, data);
        return { count: 1 };
      },
    },
    telegramDeliveryLog: {
      async findFirst({ where, orderBy, select } = {}) {
        let logs = [...state.telegramDeliveryLogs];
        if (where?.userId) logs = logs.filter((log) => log.userId === where.userId);
        if (where?.documentId) logs = logs.filter((log) => log.documentId === where.documentId);
        if (where?.type) logs = logs.filter((log) => log.type === where.type);
        if (where?.status) logs = logs.filter((log) => log.status === where.status);
        if (where?.createdAt?.gte) logs = logs.filter((log) => log.createdAt >= where.createdAt.gte);
        if (where?.sentAt?.not === null) logs = logs.filter((log) => log.sentAt !== null);
        if (orderBy) {
          logs.sort((left, right) => new Date(right.sentAt || right.createdAt) - new Date(left.sentAt || left.createdAt));
        }
        const log = logs[0] ?? null;
        if (!log || !select) return log;
        return Object.fromEntries(Object.keys(select).map((key) => [key, log[key]]));
      },
      async create({ data }) {
        const created = {
          id: `delivery_${state.telegramDeliveryLogs.length + 1}`,
          createdAt: new Date(),
          ...data,
        };
        state.telegramDeliveryLogs.push(created);
        return created;
      },
      async groupBy({ by, where, _count, _max }) {
        const ids = where?.userId?.in ?? [];
        let logs = state.telegramDeliveryLogs.filter((log) => ids.includes(log.userId));
        if (where?.status) logs = logs.filter((log) => log.status === where.status);
        if (where?.sentAt?.not === null) logs = logs.filter((log) => log.sentAt !== null);
        const groups = new Map();
        for (const log of logs) {
          const key = by.map((field) => log[field]).join(":");
          const group = groups.get(key) ?? Object.fromEntries(by.map((field) => [field, log[field]]));
          if (_count) group._count = { _all: (group._count?._all || 0) + 1 };
          if (_max) {
            const current = group._max?.sentAt ?? null;
            group._max = { sentAt: !current || log.sentAt > current ? log.sentAt : current };
          }
          groups.set(key, group);
        }
        return [...groups.values()];
      },
    },
    flashcardSet: {
      async findFirst({ where }) {
        const set = state.flashcardSets.find((entry) => entry.documentId === where.documentId && entry.isLatest === where.isLatest);
        return set ? { ...set, cards: set.cards.filter((card) => !card.isDeleted).sort((a, b) => a.position - b.position) } : null;
      },
    },
    examRecord: {
      async findFirst({ where }) {
        const record = state.examRecords.find((entry) => entry.documentId === where.documentId && entry.isLatest === where.isLatest);
        return record ? { ...record, questions: [...record.questions].sort((a, b) => a.position - b.position) } : null;
      },
    },
  };

  return prisma;
}

function createTestApp({ prisma = createMockPrisma(), fetchImpl = createFetchMock(), userId = "user_1" } = {}) {
  const app = express();
  app.use(express.json());
  app.use("/api", createTelegramRouter({
    prisma,
    env,
    fetchImpl,
    pacingMs: 0,
    requireAuth(req, _res, next) {
      req.session = { user: { id: userId } };
      next();
    },
  }));
  return { app, prisma, fetchImpl };
}

async function request(app, path, { method = "GET", body, headers = {} } = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json", ...headers } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => null);
    return { status: response.status, data };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function connectTelegram(app, prisma) {
  const link = await request(app, "/api/telegram/link-token", { method: "POST", body: {} });
  const token = prisma.state.telegramLinkTokens.at(-1).token;
  const webhook = await request(app, "/api/telegram/webhook", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": env.TELEGRAM_WEBHOOK_SECRET },
    body: {
      message: {
        text: `/start ${token}`,
        chat: { id: 12345, type: "private" },
        from: { id: 67890, username: "learner" },
      },
    },
  });

  assert.equal(link.status, 201);
  assert.equal(webhook.status, 200);
}

test("Telegram status, link token, webhook linking, and disconnect work", async () => {
  const { app, prisma } = createTestApp();

  const before = await request(app, "/api/telegram/status");
  assert.equal(before.status, 200);
  assert.equal(before.data.connected, false);
  assert.equal(before.data.botUsername, "studymaxing_admin_bot");

  const link = await request(app, "/api/telegram/link-token", { method: "POST", body: {} });
  assert.equal(link.status, 201);
  assert.match(link.data.deepLink, /^https:\/\/t\.me\/studymaxing_admin_bot\?start=/);
  assert.equal(link.data.deepLink.includes("user_1"), false);

  await connectTelegram(app, prisma);

  const after = await request(app, "/api/telegram/status");
  assert.equal(after.status, 200);
  assert.equal(after.data.connected, true);
  assert.ok(after.data.connectedAt);

  const disconnect = await request(app, "/api/telegram/link", { method: "DELETE" });
  assert.equal(disconnect.status, 200);
  assert.equal(disconnect.data.success, true);

  const disconnected = await request(app, "/api/telegram/status");
  assert.equal(disconnected.data.connected, false);
});

test("Telegram webhook validates secret and rejects expired start tokens without exposing user ids", async () => {
  const { app, prisma } = createTestApp();
  await request(app, "/api/telegram/link-token", { method: "POST", body: {} });
  const token = prisma.state.telegramLinkTokens.at(-1);
  token.expiresAt = new Date(Date.now() - 1000);

  const invalidSecret = await request(app, "/api/telegram/webhook", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "wrong" },
    body: { message: { text: `/start ${token.token}`, chat: { id: 1, type: "private" }, from: { id: 2 } } },
  });
  assert.equal(invalidSecret.status, 401);

  const expired = await request(app, "/api/telegram/webhook", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": env.TELEGRAM_WEBHOOK_SECRET },
    body: { message: { text: `/start ${token.token}`, chat: { id: 1, type: "private" }, from: { id: 2 } } },
  });
  assert.equal(expired.status, 200);
  assert.equal(prisma.state.telegramConnections.length, 0);
});

test("flashcard Telegram send validates connection, ownership, readiness, and logs success", async () => {
  const { app, prisma, fetchImpl } = createTestApp();

  const notConnected = await request(app, "/api/document/doc_complete/telegram/flashcards/send", { method: "POST", body: {} });
  assert.equal(notConnected.status, 409);
  assert.equal(notConnected.data.code, "telegram_not_connected");

  await connectTelegram(app, prisma);

  const wrongOwner = await request(app, "/api/document/doc_other/telegram/flashcards/send", { method: "POST", body: {} });
  assert.equal(wrongOwner.status, 403);

  const notComplete = await request(app, "/api/document/doc_processing/telegram/flashcards/send", { method: "POST", body: {} });
  assert.equal(notComplete.status, 409);
  assert.equal(notComplete.data.code, "document_not_ready");

  const notReady = await request(app, "/api/document/doc_no_cards/telegram/flashcards/send", { method: "POST", body: {} });
  assert.equal(notReady.status, 409);
  assert.equal(notReady.data.code, "flashcards_not_ready");

  const sent = await request(app, "/api/document/doc_complete/telegram/flashcards/send", { method: "POST", body: {} });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.success, true);
  assert.equal(sent.data.type, "flashcards");
  assert.equal(sent.data.itemCount, 2);
  assert.equal(prisma.state.telegramDeliveryLogs.at(-1).status, "sent");
  assert.equal(fetchImpl.calls.some((call) => String(call.text || "").includes("Basic unit of life.")), true);
});

test("exam Telegram send validates connection, ownership, readiness, and sends quiz polls", async () => {
  const { app, prisma, fetchImpl } = createTestApp();

  const notConnected = await request(app, "/api/document/doc_complete/telegram/exam/send", { method: "POST", body: {} });
  assert.equal(notConnected.status, 409);
  assert.equal(notConnected.data.code, "telegram_not_connected");

  await connectTelegram(app, prisma);

  const wrongOwner = await request(app, "/api/document/doc_other/telegram/exam/send", { method: "POST", body: {} });
  assert.equal(wrongOwner.status, 403);

  const notComplete = await request(app, "/api/document/doc_processing/telegram/exam/send", { method: "POST", body: {} });
  assert.equal(notComplete.status, 409);
  assert.equal(notComplete.data.code, "document_not_ready");

  const notReady = await request(app, "/api/document/doc_no_exam/telegram/exam/send", { method: "POST", body: {} });
  assert.equal(notReady.status, 409);
  assert.equal(notReady.data.code, "exam_not_ready");

  const sent = await request(app, "/api/document/doc_complete/telegram/exam/send", { method: "POST", body: {} });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.success, true);
  assert.equal(sent.data.type, "exam");
  assert.equal(sent.data.itemCount, 1);
  assert.equal(prisma.state.telegramDeliveryLogs.at(-1).status, "sent");
  assert.equal(fetchImpl.calls.some((call) => call.type === "quiz" && call.correct_option_id === 1), true);
});

test("Telegram API failures create failed delivery logs", async () => {
  const fetchImpl = async () => createResponse({ ok: false, description: "chat not found" }, 400);
  fetchImpl.calls = [];
  const { app, prisma } = createTestApp({ fetchImpl });
  await connectTelegram(app, prisma);

  const response = await request(app, "/api/document/doc_complete/telegram/exam/send", { method: "POST", body: {} });
  assert.equal(response.status, 400);
  assert.equal(prisma.state.telegramDeliveryLogs.at(-1).status, "failed");
  assert.match(prisma.state.telegramDeliveryLogs.at(-1).errorMessage, /chat not found/);
});
