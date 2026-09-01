import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import { createAdminRouter, deleteAdminUserData } from "./admin.js";

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
  assert.equal(response.data.total, 1);
  assert.equal(response.data.limit, 50);
  assert.equal(response.data.offset, 0);
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
    previousValue: { model: "gpt-4o-mini", reasoningEffort: null },
    newValue: { model: "gpt-5.5", reasoningEffort: "medium" },
    ipAddress: "::ffff:127.0.0.1",
  });
});

test("global sessions exclude expired rows and paginate the active query", async () => {
  const countCalls = [];
  let findManyArgs = null;
  const prisma = {
    session: {
      async count(args) {
        countCalls.push(args);
        return args.where.expiresAt.gt ? 31 : 7;
      },
      async findMany(args) {
        findManyArgs = args;
        return [{ id: "session_26", userId: "user_1", user: { id: "user_1" } }];
      },
    },
    auditLog: {
      async findMany() { return []; },
      async create() {},
    },
    async $transaction(operations) { return Promise.all(operations); },
  };
  const app = createTestApp({ prisma, auth: {} });

  const response = await request(app, "/api/admin/sessions?limit=25&offset=25&userId=user_1", null, { method: "GET" });

  assert.equal(response.status, 200);
  assert.equal(response.data.total, 31);
  assert.equal(response.data.limit, 25);
  assert.equal(response.data.offset, 25);
  assert.equal(response.data.kpis.expiredExcluded, 7);
  assert.equal(findManyArgs.skip, 25);
  assert.equal(findManyArgs.take, 25);
  assert.equal(findManyArgs.where.userId, "user_1");
  assert.ok(findManyArgs.where.expiresAt.gt instanceof Date);
  assert.ok(countCalls[1].where.expiresAt.lte instanceof Date);
});

test("audit logs paginate, filter by actor or target, and return distinct stored actions", async () => {
  let listArgs = null;
  const prisma = {
    auditLog: {
      async count() { return 52; },
      async findMany(args) {
        if (args.distinct) return [{ action: "BAN_USER" }, { action: "SET_ROLE" }];
        if (args.select?.adminId) return [{ adminId: "admin_1" }, { adminId: "admin_1" }];
        listArgs = args;
        return [{ id: "log_26", adminId: "admin_1", targetId: "user_1", action: "SET_ROLE", createdAt: new Date(), details: null }];
      },
      async create() {},
    },
    user: {
      async findMany() {
        return [
          { id: "admin_1", name: "Admin", email: "admin@example.com", role: "admin" },
          { id: "user_1", name: "Learner", email: "learner@example.com", role: "user" },
        ];
      },
    },
    async $transaction(operations) { return Promise.all(operations); },
  };
  const app = createTestApp({ prisma, auth: {} });

  const response = await request(app, "/api/admin/audit-logs?limit=25&offset=25&userId=user_1", null, { method: "GET" });

  assert.equal(response.status, 200);
  assert.equal(response.data.total, 52);
  assert.deepEqual(response.data.actions, ["BAN_USER", "SET_ROLE"]);
  assert.equal(response.data.logs[0].actor.name, "Admin");
  assert.equal(response.data.logs[0].targetUser.name, "Learner");
  assert.equal(listArgs.skip, 25);
  assert.equal(listArgs.take, 25);
  assert.deepEqual(listArgs.where.OR, [{ adminId: "user_1" }, { targetId: "user_1" }]);
});

test("bulk revoke all sessions records the count and before-after state atomically", async () => {
  const auditCreates = [];
  const prisma = {
    session: {
      async count() { return 2; },
      async deleteMany() { return { count: 3 }; },
    },
    auditLog: {
      async create(args) { auditCreates.push(args); },
    },
    async $transaction(callback) { return callback(this); },
  };
  const app = createTestApp({ prisma, auth: {} });

  const response = await request(app, "/api/admin/users/user_1/sessions", null, { method: "DELETE" });

  assert.equal(response.status, 200);
  assert.equal(response.data.revoked, 3);
  assert.equal(response.data.activeRevoked, 2);
  assert.equal(auditCreates[0].data.targetId, "user_1");
  assert.deepEqual(auditCreates[0].data.previousValue, { activeSessions: 2 });
  assert.deepEqual(auditCreates[0].data.newValue, { activeSessions: 0 });
  assert.equal(auditCreates[0].data.details.activeRevokedCount, 2);
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

test("per-user sessions query excludes expired sessions", async () => {
  let sessionWhere = null;
  const deps = {
    auth: {},
    prisma: {
      user: { async findUnique() { return { id: "user_1" }; } },
      session: {
        async findMany(args) {
          sessionWhere = args.where;
          return [];
        },
      },
      auditLog: { async create() {} },
    },
  };
  const app = createTestApp(deps);
  const before = Date.now();

  const response = await request(app, "/api/admin/users/user_1/sessions", null, { method: "GET" });

  assert.equal(response.status, 200);
  assert.equal(sessionWhere.userId, "user_1");
  assert.ok(sessionWhere.expiresAt.gt instanceof Date);
  assert.ok(sessionWhere.expiresAt.gt.getTime() >= before);
});

test("GET user limits is a pure read and does not upsert UserLimit or cap defaults", async () => {
  let userLimitUpserts = 0;
  let capUpserts = 0;
  const deps = {
    auth: {},
    prisma: {
      user: {
        async findUnique({ include }) {
          return include
            ? { id: "user_1", role: "user", plan: "free", userLimit: null }
            : { id: "user_1" };
        },
      },
      userLimit: {
        async findUnique() { return null; },
        async upsert() { userLimitUpserts += 1; },
      },
      usageCapConfig: {
        async findUnique() { return null; },
        async upsert() { capUpserts += 1; },
      },
      document: { async count() { return 0; } },
      modelUsageEvent: {
        async aggregate() {
          return { _sum: { estimatedCostUsd: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
        },
      },
      auditLog: { async create() {} },
    },
  };
  const app = createTestApp(deps);

  const response = await request(app, "/api/admin/users/user_1/limits", null, { method: "GET" });

  assert.equal(response.status, 200);
  assert.equal(response.data.userLimit, null);
  assert.equal(response.data.allowance.caps.documentCap, 5);
  assert.equal(userLimitUpserts, 0);
  assert.equal(capUpserts, 0);
});

test("bulk preview excludes already-suspended users and the acting admin", async () => {
  const deps = {
    auth: {},
    prisma: {
      user: {
        async findMany() {
          return [
            { id: "user_1", email: "one@example.com", banned: false, role: "user" },
            { id: "user_2", email: "two@example.com", banned: true, role: "user" },
            { id: "admin_1", email: "admin@example.com", banned: false, role: "admin" },
          ];
        },
      },
    },
  };
  const app = createTestApp(deps);

  const response = await request(app, "/api/admin/users/bulk-action", {
    action: "suspend",
    selection: { mode: "page", ids: ["user_1", "user_2", "admin_1"] },
    preview: true,
  });

  assert.equal(response.status, 200);
  assert.equal(response.data.matched, 3);
  assert.equal(response.data.affected, 1);
  assert.equal(response.data.confirmationText, "SUSPEND 1");
  assert.deepEqual(response.data.excluded.map((item) => item.reason).sort(), ["acting_admin", "already_suspended"]);
});

test("support login requires a reason before calling Better Auth", async () => {
  let impersonationCalls = 0;
  const deps = {
    auth: {
      api: {
        async impersonateUser() {
          impersonationCalls += 1;
          return new Response("{}");
        },
      },
    },
    prisma: {
      user: { async findUnique() { return { id: "user_1" }; } },
      auditLog: { async create() {} },
    },
  };
  const app = createTestApp(deps);

  const response = await request(app, "/api/admin/users/user_1/impersonate", { reason: "   " });

  assert.equal(response.status, 400);
  assert.equal(impersonationCalls, 0);
});

test("support login writes a dual-identity audit before impersonation", async () => {
  const events = [];
  const deps = {
    auth: {
      api: {
        async impersonateUser({ body }) {
          events.push(`impersonate:${body.userId}`);
          return new Response(JSON.stringify({ user: { id: body.userId } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    },
    prisma: {
      user: {
        async findUnique() {
          return { id: "user_1", email: "user@example.com", name: "User", role: "user" };
        },
      },
      auditLog: {
        async create({ data }) {
          events.push("audit");
          assert.equal(data.adminId, "admin_1");
          assert.equal(data.targetId, "user_1");
          assert.equal(data.details.actingAdminId, "admin_1");
          assert.equal(data.details.targetUserId, "user_1");
          assert.equal(data.details.reason, "Investigating reported issue");
          assert.equal(data.details.maxDurationMinutes, 60);
        },
      },
    },
  };
  const app = createTestApp(deps);

  const response = await request(app, "/api/admin/users/user_1/impersonate", {
    reason: "Investigating reported issue",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(events, ["audit", "impersonate:user_1"]);
});

test("user export returns structured data without session or credential tokens", async () => {
  const user = {
    id: "user_1",
    email: "learner@example.com",
    name: "Learner",
    role: "user",
    plan: "free",
    banned: false,
    storageUsed: 0,
    documentsUsed: 0,
    monthlyLimit: 5,
    lastActive: new Date("2026-08-31T00:00:00.000Z"),
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-31T00:00:00.000Z"),
  };
  const emptyListModel = { async findMany() { return []; } };
  const deps = {
    auth: {},
    prisma: {
      user: { async findUnique() { return user; } },
      document: emptyListModel,
      examAttempt: emptyListModel,
      flashcardProgress: emptyListModel,
      flashcardCardState: emptyListModel,
      usageEvent: emptyListModel,
      modelUsageEvent: emptyListModel,
      exportArtifact: emptyListModel,
      job: emptyListModel,
      telegramDeliveryLog: emptyListModel,
      session: {
        async findMany({ select }) {
          assert.equal(select.token, undefined);
          return [{ id: "session_1", expiresAt: new Date("2026-09-01T00:00:00.000Z") }];
        },
      },
      telegramConnection: { async findUnique() { return null; } },
      userLimit: { async findUnique() { return null; } },
      auditLog: { async create() {} },
    },
  };
  const app = createTestApp(deps);

  const response = await request(app, "/api/admin/users/user_1/export", null, { method: "GET" });

  assert.equal(response.status, 200);
  assert.equal(response.data.schemaVersion, 1);
  assert.equal(response.data.user.email, "learner@example.com");
  assert.equal(response.data.sessions[0].token, undefined);
  assert.equal(response.data.accounts, undefined);
});

test("erase requires the target user's exact email", async () => {
  const deps = {
    auth: {},
    prisma: {
      user: {
        async findUnique() {
          return { id: "user_1", email: "Learner@example.com" };
        },
      },
    },
  };
  const app = createTestApp(deps);

  const response = await request(app, "/api/admin/users/user_1/erase", {
    confirmation: "learner@example.com",
  });

  assert.equal(response.status, 400);
  assert.match(response.data.error, /exact email address/i);
});

test("user deletion leaves the database intact when storage cleanup fails", async () => {
  const events = [];
  const prisma = {
    document: {
      async findMany() { return [{ storageKey: "document-key" }]; },
    },
    exportArtifact: {
      async findMany() { return []; },
    },
    auditLog: {
      async create() { events.push("audit"); },
    },
    user: {
      async delete() { events.push("db-delete"); },
    },
    async $transaction(callback) {
      return callback(this);
    },
  };

  await assert.rejects(() => deleteAdminUserData({
    prisma,
    userId: "user_1",
    auditData: { adminId: "admin_1", action: "DELETE_USER", targetId: "user_1" },
    async deleteStorageFile() {
      events.push("storage-delete");
      throw new Error("storage unavailable");
    },
  }), /storage unavailable/);

  assert.deepEqual(events, ["storage-delete"]);
});

test("user deletion cleans storage, then atomically audits before deleting the row", async () => {
  const events = [];
  const prisma = {
    document: { async findMany() { return [{ storageKey: "document-key" }]; } },
    exportArtifact: { async findMany() { return [{ storageKey: "export-key" }]; } },
    auditLog: { async create() { events.push("audit"); } },
    user: { async delete() { events.push("db-delete"); } },
    async $transaction(callback) { return callback(this); },
  };

  await deleteAdminUserData({
    prisma,
    userId: "user_1",
    auditData: { adminId: "admin_1", action: "DELETE_USER", targetId: "user_1" },
    async deleteStorageFile(key) { events.push(`storage:${key}`); },
  });

  assert.deepEqual(events.slice(0, 2).sort(), ["storage:document-key", "storage:export-key"]);
  assert.deepEqual(events.slice(2), ["audit", "db-delete"]);
});
