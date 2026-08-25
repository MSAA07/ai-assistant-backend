import test from "node:test";
import assert from "node:assert/strict";

import { getAuthCookieAttributes } from "./authCookieAttributes.js";

test("HTTPS staging uses cross-site cookies even when NODE_ENV is staging", () => {
  assert.deepEqual(
    getAuthCookieAttributes({
      baseURL: "https://ai-assistant-backend-staging.up.railway.app/api/auth",
      nodeEnv: "staging",
    }),
    { sameSite: "none", secure: true, partitioned: true },
  );
});

test("HTTPS production keeps secure, partitioned cross-site cookies", () => {
  assert.deepEqual(
    getAuthCookieAttributes({
      baseURL: "https://api.studymaxing.com/api/auth",
      nodeEnv: "production",
    }),
    { sameSite: "none", secure: true, partitioned: true },
  );
});

test("local HTTP development keeps cookies usable without HTTPS", () => {
  assert.deepEqual(
    getAuthCookieAttributes({
      baseURL: "http://localhost:3001/api/auth",
      nodeEnv: "development",
    }),
    { sameSite: "lax", secure: false, partitioned: false },
  );
});

test("production retains secure cookie defaults when its base URL is unavailable", () => {
  assert.deepEqual(
    getAuthCookieAttributes({ nodeEnv: "production" }),
    { sameSite: "none", secure: true, partitioned: true },
  );
});
