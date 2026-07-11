import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBetterAuthVerificationRedirectParams,
  buildFrontendAuthActionUrl,
  buildRelativeAuthBridgeCallbackPath,
} from "./authBridgeUrls.js";

test("buildFrontendAuthActionUrl preserves allowed Vercel preview destinations", () => {
  assert.equal(
    buildFrontendAuthActionUrl({
      nextUrl: "https://my-ai-assistant-git-stage-mohammed-abushayiqahs-projects.vercel.app/?auth_action=verify-email",
      action: "verify-email",
      token: "token-123",
    }),
    "https://my-ai-assistant-git-stage-mohammed-abushayiqahs-projects.vercel.app/?auth_action=verify-email&token=token-123",
  );
});

test("buildFrontendAuthActionUrl rejects untrusted redirect destinations", () => {
  assert.equal(
    buildFrontendAuthActionUrl({
      nextUrl: "https://example.com/phish",
      action: "reset-password",
      token: "reset-123",
      env: { AUTH_EMAIL_APP_URL: "https://studymaxing.com" },
    }),
    "https://studymaxing.com/?auth_action=reset-password&token=reset-123",
  );
});

test("buildRelativeAuthBridgeCallbackPath creates a backend-relative Better Auth callback", () => {
  assert.equal(
    buildRelativeAuthBridgeCallbackPath({
      pathname: "/auth/verify-email",
      nextUrl: "https://studymaxing.com/?auth_action=verify-email",
      action: "verify-email",
    }),
    "/auth/verify-email?next=https%3A%2F%2Fstudymaxing.com%2F%3Fauth_action%3Dverify-email",
  );
});

test("buildBetterAuthVerificationRedirectParams hands the bridge token to Better Auth and returns to the frontend", () => {
  const previousOrigins = process.env.FRONTEND_ORIGINS;
  process.env.FRONTEND_ORIGINS = "https://stage.studymaxing.com";

  try {
    assert.deepEqual(
      buildBetterAuthVerificationRedirectParams({
        nextUrl: "https://stage.studymaxing.com/?auth_action=verify-email",
        token: "token-123",
      }),
      {
        token: "token-123",
        callbackURL: "https://stage.studymaxing.com/?auth_action=verify-email",
      },
    );
  } finally {
    if (previousOrigins == null) {
      delete process.env.FRONTEND_ORIGINS;
    } else {
      process.env.FRONTEND_ORIGINS = previousOrigins;
    }
  }
});
