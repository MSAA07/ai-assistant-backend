import assert from "node:assert/strict";
import test from "node:test";

import { createRequireAdmin } from "./adminGuard.js";

function createResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

test("requireAdmin rejects normal authenticated users", async () => {
  const requireAdmin = createRequireAdmin({
    prisma: {
      user: {
        async findUnique() {
          return { role: "user" };
        },
      },
    },
  });
  const req = { session: { user: { id: "user_1" } } };
  const res = createResponse();
  let nextCalled = false;

  await requireAdmin(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.error, "Forbidden");
});

test("requireAdmin allows admin users", async () => {
  const requireAdmin = createRequireAdmin({
    prisma: {
      user: {
        async findUnique() {
          return { role: "admin" };
        },
      },
    },
  });
  const req = { session: { user: { id: "admin_1" } } };
  const res = createResponse();
  let nextCalled = false;

  await requireAdmin(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
});
