import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import { createMutatingOriginGuard, isAllowedMutatingRequestOrigin } from "./mutatingOriginGuard.js";

function makeReq({ method = "POST", origin = "", referer = "" } = {}) {
  return {
    method,
    headers: {
      ...(origin ? { origin } : {}),
      ...(referer ? { referer } : {}),
    },
  };
}

test("mutating origin guard allows configured production origins", () => {
  assert.equal(
    isAllowedMutatingRequestOrigin(makeReq({ origin: "https://studymaxing.com" })),
    true,
  );
});

test("mutating origin guard allows localhost development origins", () => {
  assert.equal(
    isAllowedMutatingRequestOrigin(makeReq({ origin: "http://localhost:5173" })),
    true,
  );
});

test("mutating origin guard rejects unapproved cross-site origins", () => {
  assert.equal(
    isAllowedMutatingRequestOrigin(makeReq({ origin: "https://evil.example" })),
    false,
  );
});

test("mutating origin guard checks referer when origin is omitted", () => {
  assert.equal(
    isAllowedMutatingRequestOrigin(makeReq({ referer: "https://studymaxing.com/#/home" })),
    true,
  );
  assert.equal(
    isAllowedMutatingRequestOrigin(makeReq({ referer: "https://evil.example/path" })),
    false,
  );
});

test("mutating origin guard does not block non-mutating requests or same-origin style requests", () => {
  assert.equal(
    isAllowedMutatingRequestOrigin(makeReq({ method: "GET", origin: "https://evil.example" })),
    true,
  );
  assert.equal(isAllowedMutatingRequestOrigin(makeReq()), true);
});

async function withTestServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function createGuardedApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", createMutatingOriginGuard());
  app.options("/api/upload", (_req, res) => res.status(204).end());
  app.post("/api/upload", (_req, res) => res.json({ ok: true, route: "upload" }));
  app.post("/api/document/:id/generations", (_req, res) => res.json({ ok: true, route: "generation" }));
  app.post("/api/admin/users", (_req, res) => res.status(401).json({ error: "Unauthorized" }));
  return app;
}

test("guarded app routes allow approved mutating origins and reject unapproved origins", async () => {
  const app = createGuardedApp();
  await withTestServer(app, async (baseUrl) => {
    const allowedUpload = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: { Origin: "https://studymaxing.com" },
    });
    assert.equal(allowedUpload.status, 200);
    assert.equal((await allowedUpload.json()).route, "upload");

    const allowedGeneration = await fetch(`${baseUrl}/api/document/doc_1/generations`, {
      method: "POST",
      headers: { Origin: "http://localhost:5173" },
    });
    assert.equal(allowedGeneration.status, 200);
    assert.equal((await allowedGeneration.json()).route, "generation");

    const blocked = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(blocked.status, 403);
  });
});

test("guarded app routes keep preflight open and admin writes still require admin", async () => {
  const app = createGuardedApp();
  await withTestServer(app, async (baseUrl) => {
    const preflight = await fetch(`${baseUrl}/api/upload`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(preflight.status, 204);

    const allowedAdminWrite = await fetch(`${baseUrl}/api/admin/users`, {
      method: "POST",
      headers: { Origin: "https://studymaxing.com" },
    });
    assert.equal(allowedAdminWrite.status, 401);

    const blockedAdminWrite = await fetch(`${baseUrl}/api/admin/users`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(blockedAdminWrite.status, 403);
  });
});
