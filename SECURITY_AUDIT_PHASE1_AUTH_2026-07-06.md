# Phase 1a Authentication & Authorization Security Audit

Scope: read-only audit of backend authentication and authorization controls on 2026-07-06. No functional code was changed.

| Item | File/Line | Status (Pass/Fail/Needs Review) | Notes |
|---|---:|---|---|
| Documents route `POST /api/upload` | `routes/documents.js:324` | Pass | Protected by `requireAuth`; creates a new document for `req.session.user.id`, so no existing record ownership check is required. |
| Documents route `POST /api/document/:id/generations` | `routes/documents.js:461`, `routes/documents.js:469` | Pass | Protected by `requireAuth`; calls `getAuthorizedDocument`, which checks `document.userId === user.id` for non-admin users before queueing generation. |
| Documents route `GET /api/document/:id/generations` | `routes/documents.js:532`, `routes/documents.js:534` | Pass | Protected by `requireAuth`; calls `getAuthorizedDocument` before returning generation state. |
| Documents route `GET /api/document/:id` | `routes/documents.js:556`, `routes/documents.js:558` | Pass | Protected by `requireAuth`; calls `getAuthorizedDocument` before returning document data. |
| Documents route `GET /api/document/:id/export-pdf` | `routes/documents.js:577`, `routes/documents.js:584` | Pass | Protected by `requireAuth`; calls `getAuthorizedDocument` before building/exporting the PDF. |
| Documents route `GET /api/document/:id/excerpts` | `routes/documents.js:618`, `routes/documents.js:624` | Pass | Protected by `requireAuth`; calls `getAuthorizedDocument` before querying excerpts. |
| Documents route `PATCH /api/document/:id` | `routes/documents.js:692`, `routes/documents.js:694` | Pass | Protected by `requireAuth`; calls `getAuthorizedDocument` before rename. |
| Documents route `DELETE /api/document/:id` | `routes/documents.js:751`, `routes/documents.js:753` | Pass | Protected by `requireAuth`; calls `getAuthorizedDocument` before delete. |
| Documents ownership helper | `routes/documents.js:192` | Pass | Local equivalent to `getOwnedDocument`; loads document by ID, returns 404 when missing, and returns 403 when a non-admin user's ID does not match `document.userId`. |
| Exams route `POST /api/exam/attempt` | `routes/exams.js:146`, `routes/exams.js:156` | Pass | Protected by `requireAuth`; legacy endpoint loads the document owner and rejects mismatched `document.userId` before creating attempt. Equivalent ownership check, not the shared helper. |
| Exams route `GET /api/document/:id/exams` | `routes/exams.js:216`, `routes/exams.js:218` | Pass | Protected by `requireAuth`; calls `getOwnedDocument` before listing exam records. |
| Exams route `GET /api/exams/:examId` | `routes/exams.js:269`, `routes/exams.js:271` | Pass | Protected by `requireAuth`; calls `getOwnedExamRecord` before returning exam content. |
| Exams route `POST /api/exams/:examId/attempts` | `routes/exams.js:294`, `routes/exams.js:296` | Pass | Protected by `requireAuth`; calls `getOwnedExamRecord` before creating attempt. |
| Exams route `GET /api/exams/:examId/attempts/current` | `routes/exams.js:335`, `routes/exams.js:337` | Pass | Protected by `requireAuth`; calls `getOwnedExamRecord`, then filters current attempts by `req.session.user.id`. |
| Exams route `POST /api/exam-attempts/:attemptId/save` | `routes/exams.js:362`, `routes/exams.js:364` | Pass | Protected by `requireAuth`; calls local `getOwnedExamAttempt` before updating attempt answers. |
| Exams route `POST /api/exam-attempts/:attemptId/submit` | `routes/exams.js:393`, `routes/exams.js:395` | Pass | Protected by `requireAuth`; calls local `getOwnedExamAttempt` before scoring/submitting. |
| Exams route `POST /api/exam-attempts/:attemptId/restart` | `routes/exams.js:446`, `routes/exams.js:448` | Pass | Protected by `requireAuth`; calls local `getOwnedExamAttempt` before restart. |
| Exams route `GET /api/exam-attempts/:attemptId/review` | `routes/exams.js:484`, `routes/exams.js:486` | Pass | Protected by `requireAuth`; calls local `getOwnedExamAttempt` before returning review data. |
| Exam attempt ownership helper | `routes/exams.js:112` | Pass | Local equivalent ownership helper; requires `attempt.userId === userId` and verifies the attempt's exam document owner is the same user. |
| Flashcards route `POST /api/flashcard/progress` | `routes/flashcards.js:36`, `routes/flashcards.js:45` | Pass | Protected by `requireAuth`; legacy endpoint loads the document owner and rejects mismatched `document.userId` before writing progress. Equivalent ownership check, not the shared helper. |
| Flashcards route `GET /api/document/:id/flashcard-sets` | `routes/flashcards.js:146`, `routes/flashcards.js:148` | Pass | Protected by `requireAuth`; calls `getOwnedDocument` before listing flashcard sets. |
| Flashcards route `GET /api/flashcard-sets/:setId` | `routes/flashcards.js:196`, `routes/flashcards.js:198` | Pass | Protected by `requireAuth`; calls local `getOwnedFlashcardSet` before returning cards. |
| Flashcards route `PATCH /api/flashcard-sets/:setId/cards/:cardId/state` | `routes/flashcards.js:227`, `routes/flashcards.js:229` | Pass | Protected by `requireAuth`; calls local `getOwnedFlashcardSet`, then verifies `cardId` belongs to that set before writing state. |
| Flashcards route `GET /api/flashcard-sets/:setId/incorrect-session` | `routes/flashcards.js:297`, `routes/flashcards.js:299` | Pass | Protected by `requireAuth`; calls local `getOwnedFlashcardSet` before returning incorrect-session cards. |
| Flashcard set ownership helper | `routes/flashcards.js:12` | Pass | Local equivalent ownership helper; includes the parent document and rejects when `flashcardSet.document.userId !== userId`. |
| Exports route `POST /api/exports/exams` | `routes/exports.js:54`, `routes/exports.js:68`, `routes/exports.js:77` | Pass | Protected by `requireAuth`; calls `getOwnedExamRecord` for `examId` and local `getOwnedAttempt` for `attemptId` before creating export artifact. |
| Exports route `GET /api/exports` | `routes/exports.js:114`, `routes/exports.js:120` | Pass | Protected by `requireAuth`; list query is scoped to `where: { userId: req.session.user.id }`. |
| Exports route `GET /api/exports/:id` | `routes/exports.js:150`, `routes/exports.js:152` | Pass | Protected by `requireAuth`; calls local `getOwnedExportArtifact` before returning artifact data. |
| Exports route `GET /api/exports/:id/download` | `routes/exports.js:168`, `routes/exports.js:170` | Pass | Protected by `requireAuth`; calls local `getOwnedExportArtifact` before serving file content. |
| Export artifact ownership helper | `routes/exports.js:27` | Pass | Local equivalent ownership helper; rejects when `artifact.userId !== userId`. |
| Shared `getOwnedDocument` | `utils/routeHelpers.js:21` | Pass | Returns 404 for missing document and 403 when `document.userId !== userId`. |
| Shared `getOwnedExamRecord` | `utils/routeHelpers.js:38` | Pass | Includes parent document and rejects when `examRecord.document.userId !== userId`. |
| Admin router middleware order | `routes/admin.js:816`, `routes/admin.js:824` | Pass | `createAdminRouter` applies `router.use(requireAuth)` and `router.use(requireAdmin)` before all route declarations. |
| Admin route `GET /api/admin/users` | `routes/admin.js:828` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `POST /api/admin/users` | `routes/admin.js:900` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/users/:id` | `routes/admin.js:1036` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `PATCH /api/admin/users/:id` | `routes/admin.js:1083` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `DELETE /api/admin/users/:id` | `routes/admin.js:1147` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `POST /api/admin/users/:id/suspend` | `routes/admin.js:1181` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `POST /api/admin/users/:id/unsuspend` | `routes/admin.js:1222` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/users/:id/files` | `routes/admin.js:1258` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `DELETE /api/admin/users/:id/files/:documentId` | `routes/admin.js:1298` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/users/:id/sessions` | `routes/admin.js:1345` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `DELETE /api/admin/users/:id/sessions` | `routes/admin.js:1377` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `DELETE /api/admin/users/:id/sessions/:sessionId` | `routes/admin.js:1398` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/sessions` | `routes/admin.js:1427` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `DELETE /api/admin/sessions/:sessionId` | `routes/admin.js:1462` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/usage` | `routes/admin.js:1491` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/usage/summary` | `routes/admin.js:1553` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/usage/timeseries` | `routes/admin.js:1583` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/usage/users` | `routes/admin.js:1619` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/usage/users/:userId` | `routes/admin.js:1661` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/usage/documents` | `routes/admin.js:1746` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/usage/models` | `routes/admin.js:1786` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/usage/features` | `routes/admin.js:1819` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/usage/:userId` | `routes/admin.js:1852` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/costs/summary` | `routes/admin.js:1919` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/jobs/summary` | `routes/admin.js:1989` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/jobs/:id` | `routes/admin.js:2048` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/jobs` | `routes/admin.js:2102` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/caps/defaults` | `routes/admin.js:2202` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `POST /api/admin/caps/defaults/:plan/impact` | `routes/admin.js:2223` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `PATCH /api/admin/caps/defaults/:plan` | `routes/admin.js:2291` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/users/:id/allowance` | `routes/admin.js:2380` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/users/:id/limits` | `routes/admin.js:2402` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `PATCH /api/admin/users/:id/limits` | `routes/admin.js:2440` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `POST /api/admin/users/:id/limits/overrides` | `routes/admin.js:2553` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `POST /api/admin/users/:id/limits/overrides/clear` | `routes/admin.js:2637` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/anomalies` | `routes/admin.js:2707` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `PATCH /api/admin/anomalies/:id/resolve` | `routes/admin.js:2749` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/alerts` | `routes/admin.js:2799` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `PATCH /api/admin/alerts/:id/resolve` | `routes/admin.js:2863` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/analytics` | `routes/admin.js:2903` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/storage` | `routes/admin.js:2954` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/audit-logs` | `routes/admin.js:2991` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/features` | `routes/admin.js:3036` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `POST /api/admin/features/:key/toggle` | `routes/admin.js:3060` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `POST /api/admin/features/:key/grant` | `routes/admin.js:3088` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `POST /api/admin/features/:key/revoke` | `routes/admin.js:3122` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin route `GET /api/admin/features/audit` | `routes/admin.js:3154` | Pass | Behind router-level `requireAuth` and `requireAdmin`. |
| Admin QA router mount | `server.js:120`, `routes/qa.js:1852` | Pass | `routes/qa.js` handlers do not apply auth internally, but the entire router is mounted behind `requireAuth` and `requireAdmin` at `/api/admin/qa`. |
| Better Auth cookie config in `auth.js` | `auth.js:181` | Pass | `advanced.defaultCookieAttributes` sets `sameSite: isProduction ? "none" : "lax"`, `secure: isProduction`, and `partitioned: isProduction`. `httpOnly` is not overridden in `auth.js`; Better Auth's cookie defaults set `httpOnly: true`. |
| Better Auth session expiry | `auth.js:73`, `node_modules/better-auth/dist/context/create-context.mjs:120` | Pass | `auth.js` does not define a `session` block, so Better Auth uses default `expiresIn: 3600 * 24 * 7` seconds, i.e. 604800 seconds / 7 days. |
| Login rate limiting | `middleware/authHardening.js:15`, `utils/authRateLimit.js:67` | Pass | `POST /api/auth/sign-in/email` maps to `sign_in`; limits are IP 10 per 10 minutes, email 6 per 10 minutes, and IP+email 5 per 10 minutes. |
| Signup rate limiting | `middleware/authHardening.js:14`, `utils/authRateLimit.js:63` | Pass | `POST /api/auth/sign-up/email` maps to `sign_up`; limits are IP 5 per 10 minutes and email 3 per 30 minutes. |
| Password reset request rate limiting | `middleware/authHardening.js:18`, `utils/authRateLimit.js:76` | Pass | `POST /api/auth/request-password-reset` maps to `forgot_password`; limits are IP 5 per 10 minutes and email 3 per 30 minutes. |
| Password reset submit rate limiting | `middleware/authHardening.js:19`, `utils/authRateLimit.js:80` | Pass | `POST /api/auth/reset-password` maps to `reset_password`; limits are IP 5 per 15 minutes and token 3 per 30 minutes. |
| Rate limiter storage | `utils/authRateLimit.js:3`, `utils/authRateLimit.js:125` | Needs Review | Auth rate limiting is in-memory (`storeMode: "memory"`), so limits are per-process and reset on restart. This is acceptable only if the deployment topology accounts for it. |
| Login enumeration via normal invalid credentials | `node_modules/better-auth/dist/api/routes/sign-in.mjs:198` | Pass | Missing email, missing credential account, missing password, and bad password all throw `INVALID_EMAIL_OR_PASSWORD`; normal login misses do not reveal whether an account exists. |
| Login enumeration via unverified email | `node_modules/better-auth/dist/api/routes/sign-in.mjs:223` | Needs Review | Existing but unverified users receive `EMAIL_NOT_VERIFIED`, while nonexistent users receive `INVALID_EMAIL_OR_PASSWORD`. Because `auth.js` sets `requireEmailVerification: true` and `sendOnSignIn: true`, this can reveal that an email is registered but unverified. |
| Signup enumeration | `node_modules/better-auth/dist/api/routes/sign-up.mjs:158`, `auth.js:111` | Fail | Existing email signup throws `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`, which reveals that the email is already registered. `auth.js` defines `onExistingUserSignUp`, but the installed Better Auth route still throws the explicit existing-user error at this code path. |
| Password reset enumeration | `node_modules/better-auth/dist/api/routes/password.mjs:49` | Pass | Request password reset returns the same message for missing and existing users: "If this email exists in our system, check your email for the reset link". |
| Telegram webhook secret validation | `routes/telegram.js:60`, `routes/telegram.js:65`, `routes/telegram.js:386` | Pass | `POST /api/telegram/webhook` calls `validateWebhookSecret` before processing. It requires `TELEGRAM_WEBHOOK_SECRET`, reads `x-telegram-bot-api-secret-token`, and compares with `timingSafeEqual`; invalid/missing secret returns 401. |
| Telegram webhook auth middleware | `routes/telegram.js:386`, `routes/telegram.js:260` | Needs Review | The webhook has no session auth middleware by design and can create/update Telegram account links after validating a link token. It is protected by the Telegram secret token, not `requireAuth`. |
| User route `GET /api/user/me` | `routes/user.js:10` | Pass | Touches user profile and documents; protected by `requireAuth` and scoped to `req.session.user.id`. |
| User route `GET /api/user/export` | `routes/user.js:97` | Pass | Touches profile, documents, flashcards, exam attempts, and Telegram metadata; protected by `requireAuth` and scoped to `req.session.user.id`. |
| User route `GET /api/user/allowance` | `routes/user.js:240` | Pass | Touches user allowance data; protected by `requireAuth` and scoped to `req.session.user.id`. |
| Jobs route `GET /api/jobs/:id` | `routes/jobs.js:8` | Pass | Protected by `requireAuth`; non-admin users are rejected unless `job.userId === req.session.user.id`. |
| Telegram route `GET /api/telegram/status` | `routes/telegram.js:405` | Pass | Touches Telegram connection/delivery metadata; protected by `requireAuth` and scoped to `req.session.user.id`. |
| Telegram route `POST /api/telegram/link-token` | `routes/telegram.js:419` | Pass | Creates a Telegram link token; protected by `requireAuth`, rate limited, and writes `userId: req.session.user.id`. |
| Telegram route `DELETE /api/telegram/link` | `routes/telegram.js:453` | Pass | Disconnects Telegram; protected by `requireAuth` and updates only rows for `req.session.user.id`. |
| Telegram route `POST /api/document/:id/telegram/flashcards/send` | `routes/telegram.js:569`, `routes/telegram.js:490` | Pass | Protected by `requireAuth`; calls `getOwnedReadyDocument` before sending content. |
| Telegram route `POST /api/document/:id/telegram/exam/send` | `routes/telegram.js:573`, `routes/telegram.js:490` | Pass | Protected by `requireAuth`; calls `getOwnedReadyDocument` before sending content. |
| Public health route | `server.js:99` | Needs Review | No auth middleware. It does not return individual user records, but it exposes operational auth/email/security diagnostics. |
| Public Better Auth routes | `server.js:74`, `server.js:94` | Needs Review | `/api/auth/*` is intentionally public for login/signup/reset flows and is preceded by `createAuthHardeningMiddleware`; these routes touch user records as part of authentication. |
| Public redirect helpers | `server.js:76`, `server.js:85` | Pass | `/verify-email` and `/reset-password/:token` only redirect to Better Auth callback URLs and do not directly query user data. |
| Route touching user data with no auth middleware | `routes/telegram.js:386` | Needs Review | Only identified non-session-auth route that touches account-linked data is `POST /api/telegram/webhook`; it validates Telegram's secret token before processing, but does not use `requireAuth`. |
| Route touching user data with no auth middleware | `server.js:94` | Needs Review | `/api/auth/*` endpoints are public by design and touch user data for authentication. Login/signup/reset are protected by auth hardening/rate limits, not by session auth. |

