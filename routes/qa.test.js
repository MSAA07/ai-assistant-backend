import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import { __qaTestables, createQaRouter } from "./qa.js";

const { assertQaServiceIsStaging, getStagingBaseUrl, normalizeTarget } = __qaTestables;

async function requestQaRoute(path, body) {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/qa", createQaRouter({
    prisma: {},
    auth: {},
    env: { RAILWAY_SERVICE_NAME: "studymaxing-backend-staging" },
  }));
  const server = app.listen(0);

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/admin/qa${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("QA target normalization accepts staging only", () => {
  assert.equal(normalizeTarget("staging"), "staging");
  assert.equal(normalizeTarget(" STAGING "), "staging");
  assert.equal(normalizeTarget("production"), "");
  assert.equal(normalizeTarget("prod"), "");
  assert.equal(normalizeTarget(undefined), "");
});

test("QA run routes reject a production target before starting work", async () => {
  const response = await requestQaRoute("/health", { target: "production" });

  assert.equal(response.status, 400);
  assert.equal(response.data.error, "target must be staging");
});

test("QA routes reject any service other than the named staging backend", () => {
  assert.equal(
    assertQaServiceIsStaging({ RAILWAY_SERVICE_NAME: "studymaxing-backend-staging" }),
    "studymaxing-backend-staging",
  );
  assert.throws(
    () => assertQaServiceIsStaging({ RAILWAY_SERVICE_NAME: "studymaxing-production" }),
    /available only on studymaxing-backend-staging/,
  );
  assert.throws(
    () => assertQaServiceIsStaging({}),
    /available only on studymaxing-backend-staging/,
  );
});

test("QA staging URL has no fallback when its explicit variable is unset", () => {
  assert.throws(
    () => getStagingBaseUrl({
      QA_API_BASE_URL: "https://api-production.example.com",
      QA_PRODUCTION_API_BASE_URL: "https://api-production.example.com",
    }),
    /QA_STAGING_API_BASE_URL is required/,
  );
});

test("QA staging URL rejects production-shaped and non-staging hosts", () => {
  assert.throws(
    () => getStagingBaseUrl({ QA_STAGING_API_BASE_URL: "https://api-production.example.com" }),
    /must be an HTTPS staging host/,
  );
  assert.throws(
    () => getStagingBaseUrl({ QA_STAGING_API_BASE_URL: "https://studymaxing.com" }),
    /must be an HTTPS staging host/,
  );
});

test("QA staging URL accepts and normalizes an explicit staging host", () => {
  assert.equal(
    getStagingBaseUrl({ QA_STAGING_API_BASE_URL: "https://api-staging.example.com/" }),
    "https://api-staging.example.com",
  );
});
