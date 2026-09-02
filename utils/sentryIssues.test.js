import assert from "node:assert/strict";
import test from "node:test";

import { createSentryIssuesClient, getSentryIssuesConfig } from "./sentryIssues.js";

const env = {
  SENTRY_ISSUES_AUTH_TOKEN: "test-token",
  SENTRY_ORG: "studymaxing",
  SENTRY_PROJECT: "backend",
  SENTRY_ENVIRONMENT: "staging",
  SENTRY_ISSUES_CACHE_TTL_MS: "90000",
};

test("Sentry issues client caches within TTL and filters the REST request to staging", async () => {
  let now = 1_000_000;
  let calls = 0;
  const client = createSentryIssuesClient({
    env,
    now: () => now,
    async fetchImpl(url, options) {
      calls += 1;
      assert.equal(url.searchParams.get("environment"), "staging");
      assert.equal(options.headers.Authorization, "Bearer test-token");
      return new Response(JSON.stringify([{
        id: "123",
        shortId: "BACKEND-1",
        title: "Queue timeout",
        level: "error",
        lastSeen: "2026-09-02T09:00:00.000Z",
      }]), { status: 200 });
    },
  });

  const first = await client.getIssues();
  now += 30_000;
  const second = await client.getIssues();

  assert.equal(calls, 1);
  assert.equal(first.status, "fresh");
  assert.equal(second.items[0].severity, "critical");
});

test("Sentry issues client serves stale cache when a refresh fails", async () => {
  let now = 1_000_000;
  let fail = false;
  const client = createSentryIssuesClient({
    env,
    now: () => now,
    async fetchImpl() {
      if (fail) return new Response("down", { status: 503 });
      return new Response(JSON.stringify([{ id: "456", title: "Cached issue", level: "warning" }]), { status: 200 });
    },
  });

  await client.getIssues();
  now += 91_000;
  fail = true;
  const stale = await client.getIssues();

  assert.equal(stale.status, "stale");
  assert.equal(stale.items[0].id, "456");
  assert.match(stale.error, /503/);
});

test("Sentry cache TTL is constrained to the requested 60-120 second window", () => {
  assert.equal(getSentryIssuesConfig({ ...env, SENTRY_ISSUES_CACHE_TTL_MS: "1000" }).ttlMs, 60_000);
  assert.equal(getSentryIssuesConfig({ ...env, SENTRY_ISSUES_CACHE_TTL_MS: "999999" }).ttlMs, 120_000);
});
