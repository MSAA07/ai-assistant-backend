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
        async create() {},
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
