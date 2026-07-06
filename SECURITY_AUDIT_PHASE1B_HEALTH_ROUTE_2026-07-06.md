# Phase 1b Health Route Investigation

Scope: read-only trace of the public `GET /api/health` route on 2026-07-06. No functional code was changed for this investigation.

| Item | File/Line | Status (Pass/Fail/Needs Review) | Notes |
|---|---:|---|---|
| Public route registration | `server.js:99` | Needs Review | `GET /api/health` is public and has no `requireAuth` or `requireAdmin` middleware. |
| Response shape | `server.js:100` | Pass | Handler returns `res.json({ status, message, authEmail, authCallbacks, authTelemetry, authSecurity, betterAuthBaseURL })`. It does not run async work, query Prisma, test database connectivity, or catch/return stack traces. |
| `status` | `server.js:101` | Pass | Static string `"ok"`. Not derived from database, dependency health, or external service checks. |
| `message` | `server.js:102` | Pass | Static string `"AI Study Assistant API is running"`. Does not include version, environment, hostname, or stack data. |
| `authEmail.provider` | `server.js:103`, `utils/email.js:37` | Needs Review | Derived from `AUTH_EMAIL_PROVIDER` or default `"resend"`. Exposes configured provider name but not secret values. |
| `authEmail.hasResendApiKey` | `server.js:103`, `utils/email.js:45` | Needs Review | Boolean derived from whether `RESEND_API_KEY` is set. Does not echo the key, but reveals secret presence. |
| `authEmail.fromEmail` | `server.js:103`, `utils/email.js:39` | Needs Review | Echoes the configured `AUTH_EMAIL_FROM_EMAIL` value verbatim, or `""`. This can expose an internal/sender email address. |
| `authEmail.fromName` | `server.js:103`, `utils/email.js:47` | Needs Review | Echoes `AUTH_EMAIL_FROM_NAME` or default `"Studymaxing"`. Low sensitivity. |
| `authEmail.replyTo` | `server.js:103`, `utils/email.js:40` | Needs Review | Echoes `AUTH_EMAIL_REPLY_TO` verbatim, or `""`. This can expose a support/reply mailbox. |
| `authEmail.supportEmail` | `server.js:103`, `utils/email.js:41` | Needs Review | Echoes `AUTH_EMAIL_SUPPORT_EMAIL` verbatim, or `""`. This can expose a support mailbox. |
| `authEmail.diagnostics.lastAttemptAt` | `server.js:103`, `utils/email.js:9`, `utils/email.js:63` | Needs Review | Runtime in-memory diagnostic timestamp. Initially `""`; after email send attempts, becomes an ISO timestamp. |
| `authEmail.diagnostics.lastResult` | `server.js:103`, `utils/email.js:10`, `utils/email.js:123` | Needs Review | Runtime in-memory email status. Values observed in code include `"idle"`, `"attempted"`, `"accepted"`, and `"rejected"`. |
| `authEmail.diagnostics.lastContext` | `server.js:103`, `utils/email.js:12`, `utils/email.js:64` | Needs Review | Runtime in-memory context string for the last email attempt, such as `"send-reset-password"`, `"send-verification"`, or `"existing-user-signup"`. |
| `authEmail.diagnostics.lastMessageId` | `server.js:103`, `utils/email.js:13`, `utils/email.js:121` | Needs Review | Runtime in-memory Resend provider message ID from the last accepted email. Exposes provider identifier, not email body or recipient. |
| `authEmail.diagnostics.lastError` | `server.js:103`, `utils/email.js:14`, `utils/email.js:104` | Needs Review | Runtime in-memory error text from the last rejected email. Could include provider rejection detail or configuration error messages. |
| `authCallbacks.lastAction` | `server.js:104`, `utils/authCallbackUrls.js:3`, `utils/authCallbackUrls.js:134` | Needs Review | Runtime in-memory value for the last auth email callback action, e.g. `"verify-email"` or `"reset-password"`. Initially `""`. |
| `authCallbacks.lastUpdatedAt` | `server.js:104`, `utils/authCallbackUrls.js:5`, `utils/authCallbackUrls.js:136` | Needs Review | Runtime in-memory ISO timestamp for the last callback URL resolution. Initially `""`. |
| `authCallbacks.lastCallbackSource` | `server.js:104`, `utils/authCallbackUrls.js:6`, `utils/authCallbackUrls.js:96` | Needs Review | Runtime in-memory source label. Possible values include `"request"`, `"env"`, `"app_url"`, `"production_default"`, and `"raw_better_auth_url"`. |
| `authCallbacks.lastCallbackUrl` | `server.js:104`, `utils/authCallbackUrls.js:7`, `utils/authCallbackUrls.js:138` | Needs Review | Runtime in-memory frontend callback URL with `token` query value redacted. Can expose configured frontend/internal callback URLs. |
| `authCallbacks.lastCallbackHost` | `server.js:104`, `utils/authCallbackUrls.js:8`, `utils/authCallbackUrls.js:139` | Needs Review | Runtime in-memory host extracted from the last callback URL. Can expose configured callback hostnames. |
| `authCallbacks.lastRawAuthUrl` | `server.js:104`, `utils/authCallbackUrls.js:9`, `utils/authCallbackUrls.js:148` | Needs Review | Runtime in-memory Better Auth URL with `token` redacted. Can expose backend auth callback URL/host. |
| `authCallbacks.lastResolvedActionUrl` | `server.js:104`, `utils/authCallbackUrls.js:10`, `utils/authCallbackUrls.js:149` | Needs Review | Runtime in-memory final action URL with `token` redacted. Can expose configured frontend URL/host. |
| `authTelemetry.counters` | `server.js:105`, `utils/authTelemetry.js:92` | Needs Review | Runtime in-memory object of auth event counters. Event keys can reveal recent auth activity types, but not secret values. |
| `authTelemetry.recentEvents` | `server.js:105`, `utils/authTelemetry.js:5`, `utils/authTelemetry.js:56` | Needs Review | Runtime in-memory list of up to 50 recent auth events. Details can include masked email addresses, hashed/masked IP values, statuses, action names, paths, and sanitized error messages. |
| `authSecurity.rateLimit.storeMode` | `server.js:106`, `middleware/authHardening.js:160`, `utils/authRateLimit.js:125` | Needs Review | Static string `"memory"`, revealing that auth rate limiting is process-local/in-memory. |
| `authSecurity.rateLimit.rules.sign_up` | `server.js:106`, `utils/authRateLimit.js:63` | Needs Review | Exposes current signup rate-limit rules after env overrides: IP 5 per 10 minutes and email 3 per 30 minutes by default. |
| `authSecurity.rateLimit.rules.sign_in` | `server.js:106`, `utils/authRateLimit.js:67` | Needs Review | Exposes current sign-in rate-limit rules after env overrides: IP 10 per 10 minutes, email 6 per 10 minutes, IP+email 5 per 10 minutes by default. |
| `authSecurity.rateLimit.rules.resend_verification` | `server.js:106`, `utils/authRateLimit.js:72` | Needs Review | Exposes current resend-verification rate-limit rules after env overrides: IP 5 per 10 minutes and email 3 per 30 minutes by default. |
| `authSecurity.rateLimit.rules.forgot_password` | `server.js:106`, `utils/authRateLimit.js:76` | Needs Review | Exposes current forgot-password rate-limit rules after env overrides: IP 5 per 10 minutes and email 3 per 30 minutes by default. |
| `authSecurity.rateLimit.rules.reset_password` | `server.js:106`, `utils/authRateLimit.js:80` | Needs Review | Exposes current reset-password rate-limit rules after env overrides: IP 5 per 15 minutes and token 3 per 30 minutes by default. |
| `authSecurity.rateLimit.rules.change_password` | `server.js:106`, `utils/authRateLimit.js:84` | Needs Review | Exposes current change-password rate-limit rules after env overrides: IP 10 per 15 minutes and session 5 per 15 minutes by default. |
| `authSecurity.challenge.provider` | `server.js:106`, `middleware/authHardening.js:163`, `utils/authChallenge.js:22` | Needs Review | Returns `"turnstile"` only when `AUTH_CHALLENGE_PROVIDER` is `"turnstile"` and `AUTH_TURNSTILE_SECRET_KEY` is set; otherwise returns `"disabled"`. Reveals whether challenge protection is configured. |
| `authSecurity.challenge.supportEmail` | `server.js:106`, `middleware/authHardening.js:164`, `middleware/authHardening.js:30` | Needs Review | Echoes `AUTH_EMAIL_SUPPORT_EMAIL`, or `AUTH_EMAIL_REPLY_TO`, or `""`. Can expose a support/reply mailbox. |
| `betterAuthBaseURL` | `server.js:107`, `auth.js:25`, `auth.js:49` | Needs Review | Echoes the resolved Better Auth base URL derived from `BETTER_AUTH_URL` or `BETTER_AUTH_BASE_URL`, with `/api/auth` appended when needed. Can expose backend/internal auth URL or deployment hostname. |
| Database connection state | `server.js:99` | Pass | The health handler does not perform a database query and does not return database connection state. |
| Service versions/build metadata | `server.js:99` | Pass | The health handler does not return package versions, git SHA, build ID, Node version, or dependency versions. |
| Stack traces on error | `server.js:99`, `server.js:128` | Pass | The health handler has no explicit error branch and does not include stack traces in its JSON body. The global error handler returns only `"Internal Server Error"` for 5xx responses. |
| Environment variable names | `server.js:99`, `utils/email.js:37`, `auth.js:25` | Needs Review | The response does not list env var names directly, but several values are directly derived from env vars and some are echoed verbatim as noted above. |

