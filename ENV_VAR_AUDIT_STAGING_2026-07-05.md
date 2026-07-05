# Staging Environment Variable Usage Audit - 2026-07-05

Scope: `ai-assistant-backend/` source tree. Primary search target was literal dot-form reads matching `process.env.VARIABLE_NAME`. I also traced runtime import reachability from `server.js` and `worker.js`, and I call out indirect reads where code defaults an `env` parameter to `process.env` or uses bracket access such as `process.env[envName]`.

Verdict meanings:

- `backend-only`: read by `server.js`, a server route, or a module reachable only from the server runtime/startup path.
- `worker-only`: read by `worker.js` or a module reachable only from the worker runtime/startup path.
- `both`: read by a module reachable from both `server.js` and `worker.js`, or by the shared startup wrapper used for both.
- `not read anywhere in the codebase`: no literal direct read and no identified indirect runtime read in backend source.

## ADMIN_ALERT_EMAIL

- Direct `process.env.ADMIN_ALERT_EMAIL` reads: none.
- Indirect read: `utils/adminAlerts.js:71` reads `env.ADMIN_ALERT_EMAIL`; `env` defaults to `process.env` in `getAdminAlertConfig(env = process.env)`.
- Runtime/import classification: `utils/adminAlerts.js` is imported by `worker.js` only.
- Verdict: `worker-only`.

## ALERT_FROM_EMAIL

- Direct `process.env.ALERT_FROM_EMAIL` reads: none.
- Indirect read: `utils/adminAlerts.js:72` reads `env.ALERT_FROM_EMAIL`; `env` defaults to `process.env` in `getAdminAlertConfig(env = process.env)`.
- Runtime/import classification: `utils/adminAlerts.js` is imported by `worker.js` only.
- Verdict: `worker-only`.

## ALERTS_ENABLED

- Direct `process.env.ALERTS_ENABLED` reads: none.
- Indirect read: `utils/adminAlerts.js:69` reads `env.ALERTS_ENABLED`; `env` defaults to `process.env` in `getAdminAlertConfig(env = process.env)`.
- Runtime/import classification: `utils/adminAlerts.js` is imported by `worker.js` only.
- Verdict: `worker-only`.

## AUTH_EMAIL_APP_URL

- Direct `process.env.AUTH_EMAIL_APP_URL` reads:
  - `utils/authEmailTemplates.js:93`
- Indirect reads:
  - `utils/adminAlerts.js:55` reads `env.AUTH_EMAIL_APP_URL`; `env` defaults to `process.env` in `getAppBaseUrl(env = process.env)`.
  - `utils/authCallbackUrls.js:76` reads `process.env[envName]`; `AUTH_EMAIL_APP_URL` is passed as an env name at `utils/authCallbackUrls.js:113`.
  - `utils/authBridgeUrls.js:30` reads `env.AUTH_EMAIL_APP_URL`; this file is not imported by `server.js` or `worker.js` in the current graph.
- Runtime/import classification: `utils/authEmailTemplates.js` is imported by `auth.js`, which is imported by `server.js`; `utils/authCallbackUrls.js` is imported by `server.js`; `utils/adminAlerts.js` is imported by `worker.js`; `utils/authBridgeUrls.js` appears standalone/test-covered only.
- Verdict: `both`.

## AUTH_EMAIL_FROM_EMAIL

- Direct `process.env.AUTH_EMAIL_FROM_EMAIL` reads:
  - `utils/email.js:39`
  - `scripts/print-auth-config.js:30`
- Bracket read:
  - `utils/email.js:2` reads `process.env[name]`; `AUTH_EMAIL_FROM_EMAIL` is passed to `getRequiredEnv` at `utils/email.js:23`.
- Runtime/import classification: `utils/email.js` is imported by `auth.js`, which is imported by `server.js`; `scripts/print-auth-config.js` is a standalone diagnostic script.
- Verdict: `backend-only`.

## AUTH_EMAIL_FROM_NAME

- Direct `process.env.AUTH_EMAIL_FROM_NAME` reads:
  - `utils/email.js:28`
  - `utils/email.js:47`
  - `scripts/print-auth-config.js:31`
- Runtime/import classification: `utils/email.js` is imported by `auth.js`, which is imported by `server.js`; `scripts/print-auth-config.js` is a standalone diagnostic script.
- Verdict: `backend-only`.

## AUTH_EMAIL_REPLY_TO

- Direct `process.env.AUTH_EMAIL_REPLY_TO` reads:
  - `auth.js:47`
  - `middleware/authHardening.js:32`
  - `utils/email.js:29`
  - `utils/email.js:40`
  - `scripts/print-auth-config.js:32`
- Runtime/import classification: `auth.js`, `middleware/authHardening.js`, and `utils/email.js` are reachable from `server.js`; `scripts/print-auth-config.js` is a standalone diagnostic script.
- Verdict: `backend-only`.

## AUTH_EMAIL_SUPPORT_EMAIL

- Direct `process.env.AUTH_EMAIL_SUPPORT_EMAIL` reads:
  - `auth.js:46`
  - `middleware/authHardening.js:31`
  - `utils/email.js:41`
- Runtime/import classification: all three files are reachable from `server.js` only.
- Verdict: `backend-only`.

## BETTER_AUTH_BASE_URL

- Direct `process.env.BETTER_AUTH_BASE_URL` reads:
  - `auth.js:26`
  - `scripts/print-auth-config.js:7`
  - `scripts/print-auth-config.js:27`
- Runtime/import classification: `auth.js` is imported by `server.js`; `scripts/print-auth-config.js` is a standalone diagnostic script.
- Verdict: `backend-only`.

## BETTER_AUTH_SECRET

- Direct `process.env.BETTER_AUTH_SECRET` reads: none.
- Runtime/import classification: not applicable.
- Verdict: `not read anywhere in the codebase`.

## DATABASE_URL

- Direct `process.env.DATABASE_URL` reads:
  - `scripts/create-test-user.js:16`
- Runtime/import classification: `scripts/create-test-user.js` is a standalone backend script, not imported by `server.js` or `worker.js`.
- Verdict: `backend-only` for the repo/script surface; not read directly by `server.js`, `worker.js`, or their imported modules.

## FRONTEND_ORIGINS

- Direct `process.env.FRONTEND_ORIGINS` reads:
  - `utils/frontendOrigins.js:60`
- Runtime/import classification: `utils/frontendOrigins.js` is imported by `server.js` and also by `utils/authCallbackUrls.js`; not reachable from `worker.js`.
- Verdict: `backend-only`.

## MISTRAL_API_KEY

- Direct `process.env.MISTRAL_API_KEY` reads:
  - `utils/mistralOcr.js:8`
- Bracket read:
  - `routes/qa.js:1229` reads `process.env[envKey]`; `MISTRAL_API_KEY` is passed as an env key at `routes/qa.js:1296`.
- Runtime/import classification: `utils/mistralOcr.js` is imported by `utils/extractionPipeline.js`, which is imported by `worker.js`; `routes/qa.js` is imported by `server.js`.
- Verdict: `both`.

## NODE_ENV

- Direct `process.env.NODE_ENV` reads:
  - `auth.js:24`
  - `utils/authCallbackUrls.js:16`
  - `utils/frontendOrigins.js:8`
  - `utils/sentry.js:47`
  - `scripts/print-auth-config.js:29`
  - `scripts/run-with-prisma.js:10`
- Indirect reads:
  - `utils/storage.js:22` reads `env.NODE_ENV`; `env` defaults to `process.env` in `isProductionLikeStorageEnvironment(env = process.env)`.
  - `utils/telegramNotify.js:65` reads `env.NODE_ENV`; `env` defaults to `process.env` in notification send paths.
- Test assignments, not reads:
  - `utils/frontendOrigins.test.js:5`
  - `utils/frontendOrigins.test.js:20`
- Runtime/import classification: `auth.js`, `utils/authCallbackUrls.js`, and `utils/frontendOrigins.js` are server-only; `utils/sentry.js`, `utils/storage.js`, and `utils/telegramNotify.js` are imported by both `server.js` and `worker.js`; `scripts/run-with-prisma.js` is the package `start`/`worker` startup wrapper for both server and worker.
- Verdict: `both`.

## OPENAI_API_KEY

- Direct `process.env.OPENAI_API_KEY` reads:
  - `utils/studyMaterials.js:189`
  - `utils/studyMaterials.js:196`
- Bracket read:
  - `routes/qa.js:1229` reads `process.env[envKey]`; `OPENAI_API_KEY` is passed as an env key at `routes/qa.js:1288`.
- Runtime/import classification: `utils/studyMaterials.js` is imported by `utils/generationPipeline.js`, which is imported by `worker.js`; `routes/qa.js` is imported by `server.js`.
- Verdict: `both`.

## R2_ACCESS_KEY_ID

- Direct `process.env.R2_ACCESS_KEY_ID` reads:
  - `utils/storage.js:60`
- Runtime/import classification: `utils/storage.js` is imported by both server routes (`routes/documents.js`, `routes/exports.js`, `routes/admin.js`, `routes/qa.js`) and `worker.js`.
- Verdict: `both`.

## R2_BUCKET_NAME

- Direct `process.env.R2_BUCKET_NAME` reads:
  - `utils/storage.js:65`
- Runtime/import classification: `utils/storage.js` is imported by both server routes and `worker.js`.
- Verdict: `both`.

## R2_ENDPOINT

- Direct `process.env.R2_ENDPOINT` reads:
  - `utils/storage.js:58`
  - `utils/storage.js:86`
- Runtime/import classification: `utils/storage.js` is imported by both server routes and `worker.js`.
- Verdict: `both`.

## R2_SECRET_ACCESS_KEY

- Direct `process.env.R2_SECRET_ACCESS_KEY` reads:
  - `utils/storage.js:61`
- Runtime/import classification: `utils/storage.js` is imported by both server routes and `worker.js`.
- Verdict: `both`.

## RESEND_API_KEY

- Direct `process.env.RESEND_API_KEY` reads:
  - `utils/email.js:45`
- Indirect read:
  - `utils/adminAlerts.js:70` reads `env.RESEND_API_KEY`; `env` defaults to `process.env` in `getAdminAlertConfig(env = process.env)`.
- Bracket read:
  - `utils/email.js:2` reads `process.env[name]`; `RESEND_API_KEY` is passed to `getRequiredEnv` at `utils/email.js:72`.
  - `routes/qa.js:1229` reads `process.env[envKey]`; `RESEND_API_KEY` is passed as an env key at `routes/qa.js:1304`.
- Runtime/import classification: `utils/email.js` is imported by `auth.js`, which is imported by `server.js`; `routes/qa.js` is imported by `server.js`; `utils/adminAlerts.js` is imported by `worker.js`.
- Verdict: `both`.

## TELEGRAM_ADMIN_CHAT_ID

- Direct `process.env.TELEGRAM_ADMIN_CHAT_ID` reads: none.
- Indirect reads:
  - `utils/telegramNotify.js:206` reads `env.TELEGRAM_ADMIN_CHAT_ID`; `env` defaults to `process.env` in `sendTelegramAdminNotification`.
  - `utils/telegramNotify.js:276` reads `env.TELEGRAM_ADMIN_CHAT_ID`; `env` defaults to `process.env` in `sendTelegramRawNotification`.
- Runtime/import classification: `utils/telegramNotify.js` is imported by `utils/jobQueue.js` and `utils/costGuard.js` for worker paths, and by `routes/admin.js`/`routes/qa.js` for server paths.
- Verdict: `both`.

## TELEGRAM_BOT_TOKEN

- Direct `process.env.TELEGRAM_BOT_TOKEN` reads:
  - `scripts/setup-telegram-webhook.js:44`
- Indirect reads:
  - `utils/telegramDelivery.js:52` validates `env.TELEGRAM_BOT_TOKEN`; `env` defaults to `process.env` in `validateTelegramEnv`.
  - `utils/telegramDelivery.js:152` reads `env.TELEGRAM_BOT_TOKEN`; `env` defaults to `process.env` in `callTelegramApi`.
  - `utils/telegramNotify.js:205` reads `env.TELEGRAM_BOT_TOKEN`; `env` defaults to `process.env` in `sendTelegramAdminNotification`.
  - `utils/telegramNotify.js:275` reads `env.TELEGRAM_BOT_TOKEN`; `env` defaults to `process.env` in `sendTelegramRawNotification`.
- Runtime/import classification: `utils/telegramDelivery.js` is imported by `routes/telegram.js`, which is server-only; `utils/telegramNotify.js` is reachable from both server and worker; `scripts/setup-telegram-webhook.js` is a standalone setup script.
- Verdict: `both`.

## TELEGRAM_BOT_USERNAME

- Direct `process.env.TELEGRAM_BOT_USERNAME` reads: none.
- Indirect reads:
  - `utils/telegramDelivery.js:46` reads `env.TELEGRAM_BOT_USERNAME`; `env` defaults to `process.env` in `getTelegramBotUsername`.
  - `utils/telegramDelivery.js:51` validates `env.TELEGRAM_BOT_USERNAME`; `env` defaults to `process.env` in `validateTelegramEnv`.
- Runtime/import classification: `utils/telegramDelivery.js` is imported by `routes/telegram.js`, which is server-only.
- Verdict: `backend-only`.

## TELEGRAM_WEBHOOK_SECRET

- Direct `process.env.TELEGRAM_WEBHOOK_SECRET` reads:
  - `scripts/setup-telegram-webhook.js:49`
- Indirect reads:
  - `routes/telegram.js:66` reads `env.TELEGRAM_WEBHOOK_SECRET`; `env` defaults to `process.env` through the route factory option default.
  - `utils/telegramDelivery.js:53` validates `env.TELEGRAM_WEBHOOK_SECRET`; `env` defaults to `process.env` in `validateTelegramEnv`.
- Runtime/import classification: `routes/telegram.js` and `utils/telegramDelivery.js` are server-only; `scripts/setup-telegram-webhook.js` is a standalone setup script.
- Verdict: `backend-only`.

## TELEGRAM_WEBHOOK_URL

- Direct `process.env.TELEGRAM_WEBHOOK_URL` reads:
  - `scripts/setup-telegram-webhook.js:28`
- Indirect read:
  - `utils/telegramDelivery.js:54` validates `env.TELEGRAM_WEBHOOK_URL` when `requireWebhookUrl` is true; `env` defaults to `process.env` in `validateTelegramEnv`.
- Runtime/import classification: `utils/telegramDelivery.js` is server-only through `routes/telegram.js`; `scripts/setup-telegram-webhook.js` is a standalone setup script.
- Verdict: `backend-only`.

## TEST_VAR

- Direct `process.env.TEST_VAR` reads: none.
- Runtime/import classification: not applicable.
- Verdict: `not read anywhere in the codebase`.
- Note: `TEST_VAR` appears to be an orphaned variable.

## VITE_AUTH_PASSWORD_RESET_CALLBACK_URL

- Direct `process.env.VITE_AUTH_PASSWORD_RESET_CALLBACK_URL` reads: none.
- Bracket read:
  - `utils/authCallbackUrls.js:76` reads `process.env[envName]`; `VITE_AUTH_PASSWORD_RESET_CALLBACK_URL` is passed as an env name at `utils/authCallbackUrls.js:209`.
- Runtime/import classification: `utils/authCallbackUrls.js` is imported by `server.js`; not reachable from `worker.js`.
- Verdict: `backend-only`.
- VITE-prefix note: `auth.js` does not read this variable. However, backend code in `utils/authCallbackUrls.js` does read it dynamically through `process.env[envName]`, so it is not unused on the backend. The `VITE_` prefix is frontend-style naming, but this backend currently accepts it as a runtime fallback for password reset callback URLs.

## VITE_AUTH_VERIFICATION_CALLBACK_URL

- Direct `process.env.VITE_AUTH_VERIFICATION_CALLBACK_URL` reads: none.
- Bracket read:
  - `utils/authCallbackUrls.js:76` reads `process.env[envName]`; `VITE_AUTH_VERIFICATION_CALLBACK_URL` is passed as an env name at `utils/authCallbackUrls.js:197`.
- Runtime/import classification: `utils/authCallbackUrls.js` is imported by `server.js`; not reachable from `worker.js`.
- Verdict: `backend-only`.
- VITE-prefix note: `auth.js` does not read this variable. However, backend code in `utils/authCallbackUrls.js` does read it dynamically through `process.env[envName]`, so it is not unused on the backend. The `VITE_` prefix is frontend-style naming, but this backend currently accepts it as a runtime fallback for verification callback URLs.

## Additional Check: Direct `process.env.SOMETHING` Reads Not In The Provided List

These are literal dot-form `process.env.SOMETHING` reads whose variable names were not in the audit list:

| Variable | File + line | Usage classification |
| --- | --- | --- |
| `ADMIN_EMAILS` | `middleware/auth.js:5` | Server-only via `server.js` auth middleware import. |
| `ADMIN_SEED_EMAIL` | `prisma/seed.js:57` | Standalone Prisma seed script. |
| `ADMIN_SEED_NAME` | `prisma/seed.js:59` | Standalone Prisma seed script. |
| `ADMIN_SEED_PASSWORD` | `prisma/seed.js:58` | Standalone Prisma seed script. |
| `AUTH_CHALLENGE_PROVIDER` | `utils/authChallenge.js:9` | Server-only via auth hardening middleware. |
| `AUTH_EMAIL_PROVIDER` | `utils/email.js:38` | Server-only via auth email utilities. |
| `AUTH_EMAIL_PROVIDER` | `utils/email.js:61` | Server-only via auth email utilities. |
| `AUTH_EMAIL_PROVIDER` | `scripts/print-auth-config.js:33` | Standalone diagnostic script. |
| `AUTH_TURNSTILE_SECRET_KEY` | `utils/authChallenge.js:13` | Server-only via auth hardening middleware. |
| `BETTER_AUTH_URL` | `auth.js:26` | Server-only via `server.js` importing `auth.js`. |
| `BETTER_AUTH_URL` | `scripts/print-auth-config.js:7` | Standalone diagnostic script. |
| `BETTER_AUTH_URL` | `scripts/print-auth-config.js:27` | Standalone diagnostic script. |
| `CONFIRM_STAGING_TEST_USER` | `scripts/create-test-user.js:20` | Standalone test-user creation script. |
| `GENERATION_PIPELINE_V2` | `utils/studyMaterials.js:258` | Worker-only via generation pipeline. |
| `PORT` | `server.js:143` | Direct server runtime. |
| `QA_ACCOUNT_EMAIL` | `routes/qa.js:13` | Server-only via QA admin routes. |
| `QA_ACCOUNT_PASSWORD` | `routes/qa.js:14` | Server-only via QA admin routes. |
| `QA_API_BASE_URL` | `routes/qa.js:278` | Server-only via QA admin routes. |
| `QA_PRODUCTION_TARGET_URL` | `routes/qa.js:29` | Server-only via QA admin routes. |
| `QA_STAGING_TARGET_URL` | `routes/qa.js:28` | Server-only via QA admin routes. |
| `SENTRY_DSN` | `utils/sentry.js:54` | Both; `utils/sentry.js` is imported by both `server.js` and `worker.js`. |
| `SENTRY_ENVIRONMENT` | `utils/sentry.js:47` | Both; `utils/sentry.js` is imported by both `server.js` and `worker.js`. |
| `TEST_USER_EMAIL` | `scripts/create-test-user.js:10` | Standalone test-user creation script. |
| `TEST_USER_NAME` | `scripts/create-test-user.js:9` | Standalone test-user creation script. |
| `TEST_USER_PASSWORD` | `scripts/create-test-user.js:11` | Standalone test-user creation script. |

Additional indirect env names not in the provided list are also used through `env.NAME` with `env` defaulting to `process.env` or through `process.env[envName]`:

| Variable | File + line | Usage classification |
| --- | --- | --- |
| `ALERT_DAILY_COST_THRESHOLD_USD` | `utils/adminAlerts.js:74` | Worker-only via `worker.js`. |
| `ALERT_DEDUP_WINDOW_MINUTES` | `utils/adminAlerts.js:84` | Worker-only via `worker.js`. |
| `ALERT_FAILED_JOB_THRESHOLD` | `utils/adminAlerts.js:80` | Worker-only via `worker.js`. |
| `ALERT_SPIKE_MULTIPLIER` | `utils/adminAlerts.js:78` | Worker-only via `worker.js`. |
| `ALERT_USER_COST_THRESHOLD_USD` | `utils/adminAlerts.js:77` | Worker-only via `worker.js`. |
| `ADMIN_USD_TO_SAR_RATE` | `utils/modelPricing.js:56` | Both via `routes/admin.js` on server and `utils/costGuard.js` on worker. |
| `AUTH_CHALLENGE_REQUIRE_<ACTION>` | `utils/authChallenge.js:32` | Server-only via auth hardening middleware; computed key per action. |
| `AUTH_EMAIL_API_KEY` | `utils/email.js:2` via `getRequiredEnv("AUTH_EMAIL_API_KEY")` | Server-only if `AUTH_EMAIL_PROVIDER=api`; `utils/email.js` is imported through `auth.js`. |
| `AUTH_PASSWORD_RESET_CALLBACK_URL` | `utils/authCallbackUrls.js:76`, env name passed at `utils/authCallbackUrls.js:208` | Server-only via `server.js`. |
| `AUTH_RATE_LIMIT_<ACTION>_<SCOPE>_LIMIT` | `utils/authRateLimit.js:95` | Server-only via auth hardening middleware; computed key per action/scope. |
| `AUTH_RATE_LIMIT_<ACTION>_<SCOPE>_WINDOW_MS` | `utils/authRateLimit.js:93` | Server-only via auth hardening middleware; computed key per action/scope. |
| `AUTH_VERIFICATION_CALLBACK_URL` | `utils/authCallbackUrls.js:76`, env name passed at `utils/authCallbackUrls.js:196` | Server-only via `server.js`. |
| `BACKEND_DEPLOYMENT_ENV` | `utils/storage.js:28` | Both via storage utilities imported by server routes and worker. |
| `FRONTEND_URL` | `utils/adminAlerts.js:56` | Worker-only via `worker.js`. |
| `PUBLIC_APP_URL` | `utils/adminAlerts.js:57` | Worker-only via `worker.js`. |
| `QA_PRODUCTION_API_BASE_URL` | `routes/qa.js:277` | Server-only via QA admin routes; selected dynamically for production target. |
| `QA_STAGING_API_BASE_URL` | `routes/qa.js:277` | Server-only via QA admin routes; selected dynamically for staging target. |
| `RAILWAY_ENVIRONMENT` | `utils/storage.js:23`; `utils/telegramNotify.js:62` | Both via storage utilities and Telegram notifications. |
| `RAILWAY_PROJECT_ID` | `utils/storage.js:27` | Both via storage utilities imported by server routes and worker. |
| `RAILWAY_PUBLIC_DOMAIN` | `utils/storage.js:24` | Both via storage utilities imported by server routes and worker. |
| `RAILWAY_SERVICE_ID` | `utils/storage.js:26` | Both via storage utilities imported by server routes and worker. |
| `RAILWAY_STATIC_URL` | `utils/storage.js:25` | Both via storage utilities imported by server routes and worker. |
| `STAGE` | `utils/telegramNotify.js:64` | Both via server routes and worker alert paths. |
| `USE_GPT55_SUMMARY` | `utils/modelRoutingPolicy.js:14` | Worker-only via generation pipeline. |
| `USD_TO_SAR_RATE` | `utils/modelPricing.js:56` | Both via `routes/admin.js` on server and `utils/costGuard.js` on worker. |
| `VERCEL_ENV` | `utils/telegramNotify.js:63` | Both via server routes and worker alert paths. |
