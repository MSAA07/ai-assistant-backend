import test from "node:test";
import assert from "node:assert/strict";

test("production frontend origins exclude stage and localhost origins", async () => {
  process.env.NODE_ENV = "production";
  const module = await import(`./frontendOrigins.js?production=${Date.now()}`);

  assert.equal(module.isAllowedFrontendOrigin("https://studymaxing.com"), true);
  assert.equal(module.isAllowedFrontendOrigin("https://www.studymaxing.com"), true);
  assert.equal(
    module.isAllowedFrontendOrigin(
      "https://my-ai-assistant-git-stage-mohammed-abushayiqahs-projects.vercel.app",
    ),
    false,
  );
  assert.equal(module.isAllowedFrontendOrigin("http://localhost:5173"), false);
});

test("non-production frontend origins still allow preview and localhost origins", async () => {
  process.env.NODE_ENV = "test";
  const module = await import(`./frontendOrigins.js?test=${Date.now()}`);

  assert.equal(module.isAllowedFrontendOrigin("http://localhost:5173"), true);
  assert.equal(
    module.isAllowedFrontendOrigin(
      "https://my-ai-assistant-git-stage-mohammed-abushayiqahs-projects.vercel.app",
    ),
    true,
  );
  assert.equal(
    module.isAllowedFrontendOrigin("https://my-ai-assistant-some-preview.vercel.app"),
    true,
  );
});
