import test from "node:test";
import assert from "node:assert/strict";

import {
  consumeAuthRateLimit,
  resetAuthRateLimitStore,
} from "./authRateLimit.js";

test("sign-in limiter blocks repeated email+ip abuse", () => {
  resetAuthRateLimitStore();

  const context = {
    ipAddress: "203.0.113.8",
    ipMasked: "ip_test",
    email: "user@example.com",
    tokenKey: "",
    sessionKey: "",
  };

  for (let index = 0; index < 5; index += 1) {
    const result = consumeAuthRateLimit("sign_in", context);
    assert.equal(result.allowed, true);
  }

  const blocked = consumeAuthRateLimit("sign_in", context);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.rule.scope, "ip_email");
  assert.ok(blocked.retryAfterSeconds >= 1);
});

test("change-password limiter uses session scope when present", () => {
  resetAuthRateLimitStore();

  const context = {
    ipAddress: "203.0.113.21",
    ipMasked: "ip_test",
    email: "",
    tokenKey: "",
    sessionKey: "user-session-1",
  };

  for (let index = 0; index < 5; index += 1) {
    const result = consumeAuthRateLimit("change_password", context);
    assert.equal(result.allowed, true);
  }

  const blocked = consumeAuthRateLimit("change_password", context);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.rule.scope, "session");
});
