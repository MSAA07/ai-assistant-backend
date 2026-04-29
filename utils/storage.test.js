import assert from "node:assert/strict";
import test from "node:test";

import {
  assertStorageConfiguredForRuntime,
  getStorageConfigurationStatus,
} from "./storage.js";

test("storage allows local development without R2 configuration", () => {
  const status = assertStorageConfiguredForRuntime({
    NODE_ENV: "development",
  });

  assert.equal(status.productionLike, false);
  assert.equal(status.configured, false);
});

test("storage rejects production-like deployments without complete R2 configuration", () => {
  assert.throws(
    () => assertStorageConfiguredForRuntime({
      NODE_ENV: "production",
      R2_ENDPOINT: "https://r2.example",
    }),
    /R2 storage is required/,
  );
});

test("storage accepts production-like deployments with complete R2 configuration", () => {
  const status = assertStorageConfiguredForRuntime({
    NODE_ENV: "production",
    R2_ENDPOINT: "https://r2.example",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET_NAME: "bucket",
  });

  assert.equal(status.productionLike, true);
  assert.equal(status.configured, true);
});

test("storage reports missing R2 variables without exposing values", () => {
  const status = getStorageConfigurationStatus({
    RAILWAY_ENVIRONMENT: "staging",
    R2_ENDPOINT: "https://r2.example",
  });

  assert.deepEqual(status.missing, [
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET_NAME",
  ]);
});
