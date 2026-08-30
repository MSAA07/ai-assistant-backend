import test from "node:test";
import assert from "node:assert/strict";

import {
  getAllowedFrontendOrigins,
  getFrontendDeploymentMode,
  isAllowedFrontendOrigin,
} from "./frontendOrigins.js";

function withEnv(overrides, fn) {
  const previous = new Map();
  const normalizedOverrides = {
    NODE_ENV: null,
    BETTER_AUTH_URL: null,
    BETTER_AUTH_BASE_URL: null,
    RAILWAY_ENVIRONMENT: null,
    BACKEND_DEPLOYMENT_ENV: null,
    RAILWAY_PUBLIC_DOMAIN: null,
    RAILWAY_STATIC_URL: null,
    RAILWAY_SERVICE_ID: null,
    RAILWAY_PROJECT_ID: null,
    FRONTEND_ORIGINS: null,
    ...overrides,
  };

  for (const [key, value] of Object.entries(normalizedOverrides)) {
    previous.set(key, process.env[key]);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
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

test("production frontend origins exclude stage and localhost origins", () => {
  withEnv({ NODE_ENV: "production", FRONTEND_ORIGINS: "" }, () => {
    assert.equal(getFrontendDeploymentMode(), "production");

    assert.equal(isAllowedFrontendOrigin("https://studymaxing.com"), true);
    assert.equal(isAllowedFrontendOrigin("https://www.studymaxing.com"), true);
    assert.equal(
      isAllowedFrontendOrigin(
        "https://my-ai-assistant-git-stage-mohammed-abushayiqahs-projects.vercel.app",
      ),
      false,
    );
    assert.equal(isAllowedFrontendOrigin("http://localhost:5173"), false);
  });
});

test("staging trusts only its explicit frontend origin by default", () => {
  withEnv({ NODE_ENV: "staging", FRONTEND_ORIGINS: "" }, () => {
    assert.equal(getFrontendDeploymentMode(), "staging");
    assert.deepEqual(getAllowedFrontendOrigins(), ["https://stage.studymaxing.com"]);
    assert.equal(isAllowedFrontendOrigin("https://stage.studymaxing.com"), true);
    assert.equal(isAllowedFrontendOrigin("https://studymaxing.com"), false);
    assert.equal(isAllowedFrontendOrigin("http://localhost:5173"), false);
    assert.equal(
      isAllowedFrontendOrigin("https://attacker-my-ai-assistant.vercel.app"),
      false,
    );
  });
});

test("staging identity overrides an inherited production NODE_ENV", () => {
  withEnv({
    NODE_ENV: "production",
    RAILWAY_ENVIRONMENT: "staging",
    FRONTEND_ORIGINS: "",
  }, () => {
    assert.equal(getFrontendDeploymentMode(), "staging");
    assert.equal(isAllowedFrontendOrigin("https://stage.studymaxing.com"), true);
    assert.equal(isAllowedFrontendOrigin("https://studymaxing.com"), false);
  });
});

test("an unclassified HTTPS deployment fails closed to explicit origins", () => {
  withEnv({
    NODE_ENV: "custom",
    BETTER_AUTH_BASE_URL: "https://backend.example.com/api/auth",
    FRONTEND_ORIGINS: "https://frontend.example.com",
  }, () => {
    assert.equal(getFrontendDeploymentMode(), "deployed");
    assert.deepEqual(getAllowedFrontendOrigins(), ["https://frontend.example.com"]);
    assert.equal(isAllowedFrontendOrigin("https://frontend.example.com"), true);
    assert.equal(isAllowedFrontendOrigin("http://localhost:5173"), false);
    assert.equal(
      isAllowedFrontendOrigin("https://attacker-my-ai-assistant.vercel.app"),
      false,
    );
  });
});

test("local development still allows preview and localhost origins", () => {
  withEnv({
    NODE_ENV: "test",
    BETTER_AUTH_URL: null,
    BETTER_AUTH_BASE_URL: null,
    RAILWAY_ENVIRONMENT: null,
    RAILWAY_PUBLIC_DOMAIN: null,
    RAILWAY_STATIC_URL: null,
    RAILWAY_SERVICE_ID: null,
    RAILWAY_PROJECT_ID: null,
    FRONTEND_ORIGINS: "",
  }, () => {
    assert.equal(getFrontendDeploymentMode(), "local");
    assert.equal(isAllowedFrontendOrigin("http://localhost:5173"), true);
    assert.equal(
      isAllowedFrontendOrigin(
        "https://my-ai-assistant-git-stage-mohammed-abushayiqahs-projects.vercel.app",
      ),
      true,
    );
    assert.equal(
      isAllowedFrontendOrigin("https://my-ai-assistant-some-preview.vercel.app"),
      true,
    );
  });
});
