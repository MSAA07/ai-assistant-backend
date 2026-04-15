import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPasswordResetEmailActionUrl,
  buildVerificationEmailActionUrl,
} from "./authCallbackUrls.js";

async function withEnv(overrides, fn) {
  const previous = new Map();

  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("buildVerificationEmailActionUrl rewrites Better Auth links to the frontend bridge", async () => {
  await withEnv(
    {
      AUTH_VERIFICATION_CALLBACK_URL: "",
      VITE_AUTH_VERIFICATION_CALLBACK_URL: "",
      AUTH_EMAIL_APP_URL: "",
    },
    () => {
      const frontendCallback = "https://preview.example.com/?auth_action=verify-email";
      const rawUrl = `https://backend.example.com/api/auth/verify-email?token=abc123&callbackURL=${encodeURIComponent(frontendCallback)}`;

      assert.equal(
        buildVerificationEmailActionUrl({ url: rawUrl, token: "abc123" }),
        "https://preview.example.com/?auth_action=verify-email&token=abc123",
      );
    },
  );
});

test("buildVerificationEmailActionUrl prefers request callbackURL over env override", async () => {
  await withEnv(
    {
      AUTH_VERIFICATION_CALLBACK_URL: "https://stale-stage.example.com/?auth_action=verify-email",
      VITE_AUTH_VERIFICATION_CALLBACK_URL: "",
      AUTH_EMAIL_APP_URL: "",
    },
    () => {
      const frontendCallback = "https://studymaxing.com/?auth_action=verify-email";
      const rawUrl = `https://backend.example.com/api/auth/verify-email?token=abc123&callbackURL=${encodeURIComponent(frontendCallback)}`;

      assert.equal(
        buildVerificationEmailActionUrl({
          url: rawUrl,
          token: "abc123",
        }),
        "https://studymaxing.com/?auth_action=verify-email&token=abc123",
      );
    },
  );
});

test("buildVerificationEmailActionUrl falls back to AUTH_EMAIL_APP_URL when callbackURL is missing", async () => {
  await withEnv(
    {
      NODE_ENV: "",
      AUTH_VERIFICATION_CALLBACK_URL: "",
      VITE_AUTH_VERIFICATION_CALLBACK_URL: "",
      AUTH_EMAIL_APP_URL: "https://studymaxing.com",
    },
    () => {
      assert.equal(
        buildVerificationEmailActionUrl({
          url: "https://backend.example.com/api/auth/verify-email?token=abc123",
          token: "abc123",
        }),
        "https://studymaxing.com/?auth_action=verify-email&token=abc123",
      );
    },
  );
});

test("buildPasswordResetEmailActionUrl rewrites reset links to the frontend bridge", async () => {
  await withEnv(
    {
      NODE_ENV: "",
      AUTH_PASSWORD_RESET_CALLBACK_URL: "",
      VITE_AUTH_PASSWORD_RESET_CALLBACK_URL: "",
      AUTH_EMAIL_APP_URL: "",
    },
    () => {
      const frontendCallback = "https://preview.example.com/?auth_action=reset-password";
      const rawUrl = `https://backend.example.com/api/auth/reset-password/token-123?callbackURL=${encodeURIComponent(frontendCallback)}`;

      assert.equal(
        buildPasswordResetEmailActionUrl({ url: rawUrl, token: "token-123" }),
        "https://preview.example.com/?auth_action=reset-password&token=token-123",
      );
    },
  );
});

test("buildPasswordResetEmailActionUrl prefers request callbackURL over env override", async () => {
  await withEnv(
    {
      NODE_ENV: "",
      AUTH_PASSWORD_RESET_CALLBACK_URL: "https://stale-stage.example.com/?auth_action=reset-password",
      VITE_AUTH_PASSWORD_RESET_CALLBACK_URL: "",
      AUTH_EMAIL_APP_URL: "",
    },
    () => {
      const frontendCallback = "https://studymaxing.com/?auth_action=reset-password";
      const rawUrl = `https://backend.example.com/api/auth/reset-password/token-123?callbackURL=${encodeURIComponent(frontendCallback)}`;

      assert.equal(
        buildPasswordResetEmailActionUrl({
          url: rawUrl,
          token: "token-123",
        }),
        "https://studymaxing.com/?auth_action=reset-password&token=token-123",
      );
    },
  );
});

test("buildPasswordResetEmailActionUrl ignores invalid production env callback and falls back to studymaxing", async () => {
  await withEnv(
    {
      NODE_ENV: "production",
      AUTH_PASSWORD_RESET_CALLBACK_URL: "https://my-ai-assistant-git-stage.example.vercel.app/?auth_action=reset-password",
      VITE_AUTH_PASSWORD_RESET_CALLBACK_URL: "",
      AUTH_EMAIL_APP_URL: "",
    },
    async () => {
      const { buildPasswordResetEmailActionUrl: buildResetUrl } = await import(`./authCallbackUrls.js?production=${Date.now()}`);
      assert.equal(
        buildResetUrl({
          url: "https://backend.example.com/api/auth/reset-password/token-123",
          token: "token-123",
        }),
        "https://studymaxing.com/?auth_action=reset-password&token=token-123",
      );
    },
  );
});
