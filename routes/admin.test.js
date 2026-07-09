import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import { createAdminRouter } from "./admin.js";

function createTestApp({ prisma, auth }) {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", createAdminRouter({
    prisma,
    auth,
    requireAuth(req, _res, next) {
      req.session = { user: { id: "admin_1", role: "admin" } };
      next();
    },
    requireAdmin(_req, _res, next) {
      next();
    },
  }));
  return app;
}

async function request(app, path, body, { method = "POST" } = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    return { status: response.status, data };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function createMockDependencies() {
  const calls = {
    createUserBodies: [],
    userLimitUpserts: [],
    auditLogCreates: [],
  };
  const createdUser = {
    id: "user_1",
    email: "new.user@example.com",
    name: "New User",
    role: "user",
    plan: "free",
    banned: false,
    banReason: null,
    banExpires: null,
    documentsUsed: 0,
    monthlyLimit: 5,
    storageUsed: 0,
    lastActive: new Date("2026-04-29T00:00:00.000Z"),
    createdAt: new Date("2026-04-29T00:00:00.000Z"),
    updatedAt: new Date("2026-04-29T00:00:00.000Z"),
  };

  return {
    calls,
    auth: {
      api: {
        async createUser({ body }) {
          calls.createUserBodies.push(body);
          return { user: { id: createdUser.id } };
        },
      },
    },
    prisma: {
      user: {
        async findUnique() {
          return createdUser;
        },
      },
      userLimit: {
        async upsert(args) {
          calls.userLimitUpserts.push(args);
          return { userId: args.where.userId, ...args.create };
        },
      },
      auditLog: {
        async create(args) {
          calls.auditLogCreates.push(args);
        },
      },
    },
  };
}

function createModelRoutingDeps() {
  const calls = {
    auditLogCreates: [],
    updates: [],
  };
  const configs = [
    { feature: "summary", plan: "free", model: "gpt-4o-mini", reasoningEffort: null },
    { feature: "summary", plan: "premium", model: "gpt-4o-mini", reasoningEffort: null },
    { feature: "flashcards", plan: "free", model: "gpt-4o", reasoningEffort: null },
    { feature: "flashcards", plan: "premium", model: "gpt-4o", reasoningEffort: null },
    { feature: "exam", plan: "free", model: "gpt-4o", reasoningEffort: null },
    { feature: "exam", plan: "premium", model: "gpt-4o", reasoningEffort: null },
  ].map((config, index) => ({
    id: `config_${index + 1}`,
    updatedByAdminId: null,
    createdAt: new Date("2026-07-09T00:00:00.000Z"),
    updatedAt: new Date("2026-07-09T00:00:00.000Z"),
    ...config,
  }));

  const findConfig = ({ feature, plan }) => (
    configs.find((config) => config.feature === feature && config.plan === plan) ?? null
  );
  const cloneConfig = (config) => (config ? { ...config } : null);

  return {
    calls,
    auth: {},
    prisma: {
      modelRoutingConfig: {
        async findMany() {
          return configs.map(cloneConfig).sort((a, b) => (
            a.feature.localeCompare(b.feature) || a.plan.localeCompare(b.plan)
          ));
        },
        async findUnique({ where }) {
          return cloneConfig(findConfig(where.feature_plan));
        },
        async update({ where, data }) {
          calls.updates.push({ where, data });
          const config = findConfig(where.feature_plan);
          Object.assign(config, data, {
            updatedAt: new Date("2026-07-09T01:00:00.000Z"),
          });
          return cloneConfig(config);
        },
      },
      auditLog: {
        async create(args) {
          calls.auditLogCreates.push(args);
        },
      },
    },
  };
}

test("admin create user requires a temporary password", async () => {
  const deps = createMockDependencies();
  const app = createTestApp(deps);

  const response = await request(app, "/api/admin/users", {
    name: "No Password",
    email: "no-password@example.com",
    role: "user",
    plan: "free",
  });

  assert.equal(response.status, 400);
  assert.equal(response.data.error, "Temporary password is required");
  assert.equal(deps.calls.createUserBodies.length, 0);
});

test("admin create user uses Better Auth credential creation and plan defaults", async () => {
  const deps = createMockDependencies();
  const app = createTestApp(deps);

  const response = await request(app, "/api/admin/users", {
    name: "New User",
    email: "NEW.USER@example.com",
    password: "temporary-password",
    role: "user",
    plan: "free",
    monthlyLimit: 500,
  });

  assert.equal(response.status, 200);
  assert.equal(deps.calls.createUserBodies.length, 1);
  assert.deepEqual(deps.calls.createUserBodies[0], {
    email: "new.user@example.com",
    name: "New User",
    password: "temporary-password",
    role: "user",
    data: {
      plan: "free",
      emailVerified: true,
    },
  });
  assert.equal(deps.calls.userLimitUpserts.length, 0);
});

test("admin create user writes UserLimit only for custom cap overrides", async () => {
  const deps = createMockDependencies();
  const app = createTestApp(deps);

  const response = await request(app, "/api/admin/users", {
    name: "Limited User",
    email: "limited@example.com",
    password: "temporary-password",
    role: "user",
    plan: "free",
    documentCapOverride: 2,
    costCapUsdOverride: 0.2,
    tokenCapOverride: "",
  });

  assert.equal(response.status, 200);
  assert.equal(deps.calls.userLimitUpserts.length, 1);
  assert.deepEqual(deps.calls.userLimitUpserts[0].create, {
    userId: "user_1",
    documentCapOverride: 2,
    costCapUsdOverride: 0.2,
    overrideBy: "admin_1",
  });
});

test("admin create user rejects invalid cap overrides before creating auth user", async () => {
  const deps = createMockDependencies();
  const app = createTestApp(deps);

  const response = await request(app, "/api/admin/users", {
    name: "Invalid User",
    email: "invalid@example.com",
    password: "temporary-password",
    role: "user",
    plan: "free",
    documentCapOverride: -1,
  });

  assert.equal(response.status, 400);
  assert.equal(response.data.error, "documentCapOverride must be a non-negative integer");
  assert.equal(deps.calls.createUserBodies.length, 0);
});

test("admin create user rejects non-numeric cost cap overrides before creating auth user", async () => {
  const deps = createMockDependencies();
  const app = createTestApp(deps);

  const response = await request(app, "/api/admin/users", {
    name: "Invalid Cost User",
    email: "invalid-cost@example.com",
    password: "temporary-password",
    role: "user",
    plan: "free",
    costCapUsdOverride: "not-a-number",
  });

  assert.equal(response.status, 400);
  assert.equal(response.data.error, "costCapUsdOverride must be a non-negative number");
  assert.equal(deps.calls.createUserBodies.length, 0);
});

test("admin users include read-only Telegram usage indicators", async () => {
  const user = {
    id: "user_1",
    email: "telegram@example.com",
    name: "Telegram User",
    role: "user",
    plan: "free",
    banned: false,
    banReason: null,
    banExpires: null,
    documentsUsed: 0,
    monthlyLimit: 5,
    storageUsed: 0,
    lastActive: new Date("2026-05-11T00:00:00.000Z"),
    createdAt: new Date("2026-05-11T00:00:00.000Z"),
    updatedAt: new Date("2026-05-11T00:00:00.000Z"),
    _count: { documents: 1, sessions: 2 },
  };
  const deps = {
    auth: {},
    prisma: {
      async $transaction(input) {
        return Promise.all(input);
      },
      user: {
        async count() {
          return 1;
        },
        async findMany() {
          return [user];
        },
      },
      telegramConnection: {
        async findMany() {
          return [{
            userId: "user_1",
            connectedAt: new Date("2026-05-11T01:00:00.000Z"),
            disconnectedAt: null,
          }];
        },
      },
      telegramDeliveryLog: {
        async groupBy({ by }) {
          if (by.length === 2) {
            return [
              { userId: "user_1", type: "flashcards", _count: { _all: 2 } },
              { userId: "user_1", type: "exam", _count: { _all: 1 } },
            ];
          }

          return [{
            userId: "user_1",
            _max: { sentAt: new Date("2026-05-11T02:00:00.000Z") },
          }];
        },
      },
      auditLog: {
        async create() {},
      },
    },
  };
  const app = createTestApp(deps);

  const response = await request(app, "/api/admin/users", null, { method: "GET" });

  assert.equal(response.status, 200);
  assert.equal(response.data.users[0].telegram.connected, true);
  assert.equal(response.data.users[0].telegram.usedTelegramSend, true);
  assert.equal(response.data.users[0].telegram.flashcardSendCount, 2);
  assert.equal(response.data.users[0].telegram.examSendCount, 1);
  assert.equal(response.data.users[0].telegram.lastTelegramSendAt, "2026-05-11T02:00:00.000Z");
});

test("admin model routing list returns configs and allowed models", async () => {
  const deps = createModelRoutingDeps();
  const app = createTestApp(deps);

  const response = await request(app, "/api/admin/model-routing", null, { method: "GET" });

  assert.equal(response.status, 200);
  assert.equal(response.data.configs.length, 6);
  assert.equal(response.data.allowedModels.length, 9);
});

test("admin model routing update writes row and audit log", async () => {
  const deps = createModelRoutingDeps();
  const app = createTestApp(deps);

  const response = await request(app, "/api/admin/model-routing/summary/free", {
    model: "gpt-5.5",
    reasoningEffort: "medium",
  }, { method: "PATCH" });

  assert.equal(response.status, 200);
  assert.equal(response.data.model, "gpt-5.5");
  assert.equal(response.data.reasoningEffort, "medium");
  assert.equal(response.data.updatedByAdminId, "admin_1");
  assert.deepEqual(deps.calls.updates[0], {
    where: { feature_plan: { feature: "summary", plan: "free" } },
    data: {
      model: "gpt-5.5",
      reasoningEffort: "medium",
      updatedByAdminId: "admin_1",
    },
  });
  assert.equal(deps.calls.auditLogCreates.length, 1);
  assert.deepEqual(deps.calls.auditLogCreates[0].data, {
    adminId: "admin_1",
    action: "model_routing.update",
    targetId: "summary:free",
    details: {
      before: { model: "gpt-4o-mini", reasoningEffort: null },
      after: { model: "gpt-5.5", reasoningEffort: "medium" },
    },
    ipAddress: "::ffff:127.0.0.1",
  });
});

test("admin model routing update rejects invalid model", async () => {
  const deps = createModelRoutingDeps();
  const app = createTestApp(deps);

  const response = await request(app, "/api/admin/model-routing/summary/free", {
    model: "gpt-3.5-turbo",
    reasoningEffort: "medium",
  }, { method: "PATCH" });

  assert.equal(response.status, 400);
  assert.equal(response.data.error, "model must be one of the allowed model ids");
  assert.equal(deps.calls.updates.length, 0);
});

test("admin model routing update rejects reasoning effort for non-reasoning model", async () => {
  const deps = createModelRoutingDeps();
  const app = createTestApp(deps);

  const response = await request(app, "/api/admin/model-routing/summary/free", {
    model: "gpt-4o",
    reasoningEffort: "medium",
  }, { method: "PATCH" });

  assert.equal(response.status, 400);
  assert.equal(response.data.error, "reasoningEffort is only supported for models with reasoning effort enabled");
  assert.equal(deps.calls.updates.length, 0);
});
