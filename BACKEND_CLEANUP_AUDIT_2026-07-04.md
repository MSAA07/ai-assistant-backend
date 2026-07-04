# Backend cleanup audit - 2026-07-04

Scope: first-party files in `ai-assistant-backend/`, excluding `.git/` and `node_modules/`. Historical markdown reports were searched for context but are not counted below as live log statements.

## Section 1: Debug logs

The earlier `server.js` `OPENAI_API_KEY` existence/length debug logs are no longer present. The earlier `routes/documents.js` upload-request log of `userId`, `fileName`, and `fileType` is also no longer present. Current findings are below.

| File | Line | Statement | Data exposed |
| --- | ---: | --- | --- |
| `auth.js` | 61 | ``console.error(`[auth-email] ${context} failed:`, error);`` | Unsanitized auth-email error object. Depending on provider failure shape, this can expose message text, response details, stack/source paths, and potentially email-action context. |
| `prisma/seed.js` | 125 | ``console.log(`✅ Admin user created: ${adminEmail}`);`` | Full admin seed email address. |
| `scripts/create-test-user.js` | 83 | ``console.log(`Test user created: ${email}`);`` | Full created test-user email address. |
| `scripts/print-auth-config.js` | 36 | ``console.log("[auth-config] betterAuthBaseURLConfigured:", configuredBaseURL || "(missing)");`` | Configured Better Auth URL. |
| `scripts/print-auth-config.js` | 37 | ``console.log("[auth-config] betterAuthBaseURLResolved:", resolvedBetterAuthBaseURL || "(missing)");`` | Resolved Better Auth URL. |
| `scripts/print-auth-config.js` | 39 | ``console.log("[auth-config] sender:", `${senderName} <${senderEmail}>`);`` | Sender display name and sender email address. |
| `scripts/print-auth-config.js` | 40 | ``console.log("[auth-config] replyTo:", replyTo);`` | Reply-to email address. |
| `scripts/print-auth-config.js` | 43 | ``console.log(`- ${origin}`);`` | Allowed frontend origin list. |
| `scripts/setup-telegram-webhook.js` | 34 | ``console.log(`About to register Telegram webhook URL: ${webhookUrl}`);`` | Telegram webhook URL. |
| `scripts/setup-telegram-webhook.js` | 61 | ``console.log(`Telegram webhook registered for @${envCheck.botUsername}: ${webhookUrl}`);`` | Telegram bot username and webhook URL. |
| `scripts/generate-qa-files.js` | 164 | ``console.log(`Generated ${path.relative(process.cwd(), docxPath)} (${wordCount} words)`);`` | Generated local QA fixture path. |
| `scripts/generate-qa-files.js` | 193 | ``console.log(`Generated ${path.relative(process.cwd(), pipelinePdfPath)} (1 page)`);`` | Generated local QA fixture path. |
| `scripts/generate-qa-files.js` | 232 | ``console.log(`Generated ${path.relative(process.cwd(), oversizedPdfPath)} (202 pages)`);`` | Generated local QA fixture path. |
| `scripts/generate-qa-files.js` | 244 | ``console.log(`Generated ${path.relative(process.cwd(), corruptPdfPath)} (invalid PDF bytes)`);`` | Generated local QA fixture path. |
| `scripts/generate-qa-pdf.js` | 50 | ``console.log(`Generated ${outputPath}`);`` | Generated local QA PDF path. |
| `utils/authTelemetry.js` | 63 | ``console.info("[auth-event]", entry);`` | Auth telemetry event object. Known callers pass masked email, masked IP, request path, status, action, and in `middleware/auth.js:63` a raw `userId`. |
| `utils/authCallbackUrls.js` | 151 | ``console.info("[auth-callback] resolved action URL", { action, callbackSource: source, callbackHost: authCallbackDiagnostics.lastCallbackHost || "(missing)", callbackUrl: authCallbackDiagnostics.lastCallbackUrl || "(missing)", rawAuthUrl: authCallbackDiagnostics.lastRawAuthUrl || "(missing)", resolvedActionUrl: authCallbackDiagnostics.lastResolvedActionUrl || "(missing)", });`` | Callback host and redacted auth/action URLs. Tokens are redacted by helper, but URLs and hosts still expose auth-flow configuration. |
| `utils/email.js` | 107 | ``console.error("[auth-email] provider rejected send", { provider, context, status: response.status, subject, to: (Array.isArray(to) ? to : [to]).map(maskEmailAddress), error: body ?? response.statusText, });`` | Email provider, email context, subject, masked recipient email, provider response/error body. |
| `utils/email.js` | 126 | ``console.info("[auth-email] provider accepted send", { provider, context, subject, to: (Array.isArray(to) ? to : [to]).map(maskEmailAddress), messageId: providerMessageId || "(missing)", });`` | Email provider, email context, subject, masked recipient email, provider message id. |
| `utils/adminAlerts.js` | 325 | ``console.error("[admin-alerts] alert email not sent", { alertType: alert.alertType, targetType: alert.targetType, targetId: alert.targetId, status: delivery.status, error: delivery.errorMessage, });`` | Alert target id and delivery error text. |
| `utils/adminAlerts.js` | 333 | ``console.info("[admin-alerts] alert email sent", { alertType: alert.alertType, targetType: alert.targetType, targetId: alert.targetId, to: maskEmailAddress(config.to), messageId: delivery.providerMessageId || "(missing)", });`` | Alert target id, masked recipient email, provider message id. |
| `utils/adminAlerts.js` | 345 | ``console.error("[admin-alerts] alert email delivery failed", { alertType: alert.alertType, targetType: alert.targetType, targetId: alert.targetId, error: message, });`` | Alert target id and delivery error text. |
| `utils/adminAlerts.js` | 617 | ``console.error("[admin-alerts] usage alert check failed", { userId, check: check.name, error: error instanceof Error ? error.message : String(error), });`` | Raw user id and error text. |
| `utils/costGuard.js` | 134 | ``console.warn(`[costGuard] anomaly alert created for user ${userId}: $${todaySpend.toFixed(4)} vs $${(baselineUsd * 3).toFixed(4)} threshold`,);`` | Raw user id and spend/threshold amounts. |
| `utils/extractionPipeline.js` | 450 | ``console.log(`[MistralOCR] pdf-parse returned empty, falling back to Mistral OCR for: ${path.basename(filePath)}`);`` | Uploaded document basename. |
| `utils/mistralOcr.js` | 6 | ``console.log("[MistralOCR] Starting OCR for:", filename);`` | Uploaded document basename. |
| `utils/mistralOcr.js` | 28 | ``console.log("[MistralOCR] File uploaded, id:", uploadedFile.id);`` | Mistral provider file id. |
| `utils/mistralOcr.js` | 30 | ``console.log("[MistralOCR] Upload error:", err.message);`` | Provider error message; may include request/file details. |
| `utils/mistralOcr.js` | 43 | ``console.log("[MistralOCR] Signed URL error:", err.message);`` | Provider error message; may include file id or signed-URL details. |
| `utils/mistralOcr.js` | 71 | ``console.log("[MistralOCR] OCR error:", err.message);`` | Provider error message; may include request/file details. |
| `utils/mistralOcr.js` | 78 | ``console.log("[MistralOCR] File delete error (non-fatal):", err.message);`` | Provider error message; may include provider file id. |
| `utils/storage.js` | 88 | ``console.error('[storage] Failed to upload to R2:', error)`` | Unsanitized R2/S3 error object; may include bucket, object key, endpoint, request id, and stack/source paths. |
| `utils/storage.js` | 101 | ``console.error('[storage] Failed to delete from R2:', error)`` | Unsanitized R2/S3 error object; may include bucket, object key, endpoint, request id, and stack/source paths. |
| `utils/storage.js` | 147 | ``console.warn('[storage] Failed to clean up temp file:', error.message)`` | Temp-file cleanup error text. The file path is sent to Sentry separately, not to console. |
| `routes/documents.js` | 436 | ``console.info(`[upload] Using local storage fallback for document ${document.id}`);`` | Raw document id. |
| `routes/documents.js` | 455 | ``console.error("Upload error:", error);`` | Unsanitized upload error object; may include local temp paths, storage keys, document metadata, and stack/source paths. |
| `routes/documents.js` | 457 | ``console.error(error.stack);`` | Full stack trace with local source paths. |
| `routes/qa.js` | 1669 | ``console.info("[qa] QA run completed", { id: finalResult.id, target, tier, passed, failed, skipped, totalDurationMs, });`` | QA run id and target environment. |
| `routes/telegram.js` | 560 | ``console.error("[telegram] send failed:", { type, documentId, userId, error: sanitizeDeliveryError(error), });`` | Telegram delivery type, raw document id, raw user id, sanitized delivery error. |
| `utils/telegramNotify.js` | 145 | ``console.error("[telegramNotify] failed to load notification user context:", { error: getErrorSummary(error), userId: redactTelegramText(userId), });`` | Redacted user id and error summary. |
| `worker.js` | 377 | ``console.log(`[worker] started as ${WORKER_ID}, polling every 2s`);`` | Worker instance id. |
| `worker.js` | 446 | ``console.log(`[worker] processing job ${job.id} type=${job.jobType}`);`` | Raw job id and job type. |
| `worker.js` | 467 | ``console.log(`[worker] job ${job.id} succeeded`);`` | Raw job id. |
| `worker.js` | 476 | ``console.log(`[worker] job ${job.id} failed, retrying (${nextRetryCount}/${job.maxRetries})`,);`` | Raw job id and retry counts. |
| `worker.js` | 481 | ``console.error(`[worker] job ${job.id} permanently failed:`, error instanceof Error ? error.message : error,);`` | Raw job id and error message/object. |

Additional note: there are many ordinary `console.error("Error ...:", error)` statements across route and middleware files. They do not directly interpolate API keys, tokens, user ids, emails, or filenames, but any raw `Error` object printed by Node can include stack/source paths and provider/client error details. The highest-risk explicit stack print is `routes/documents.js:457`.

## Section 2: Duplicate helpers

### `utils/routeHelpers.js`

`utils/routeHelpers.js` exists and currently contains:

| Helper | Line | Current signature |
| --- | ---: | --- |
| `normalizePositiveInteger` | 3 | `export function normalizePositiveInteger(value, fallback, { min = 1, max = 100 } = {})` |
| `getOwnedDocument` | 12 | `export async function getOwnedDocument(prisma, documentId, userId)` |
| `getOwnedExamRecord` | 29 | `export async function getOwnedExamRecord(prisma, examId, userId)` |

### Original helper list

| Helper | File | Line | Status |
| --- | --- | ---: | --- |
| `normalizePositiveInteger` | `utils/routeHelpers.js` | 3 | Canonical implementation. No route-local copy found. |
| `normalizePositiveInteger` | `routes/documents.js` | 37 | Imported from `utils/routeHelpers.js`; no local copy. |
| `normalizePositiveInteger` | `routes/exams.js` | 6 | Imported from `utils/routeHelpers.js`; no local copy. |
| `normalizePositiveInteger` | `routes/exports.js` | 9 | Imported from `utils/routeHelpers.js`; no local copy. |
| `normalizePositiveInteger` | `routes/flashcards.js` | 6 | Imported from `utils/routeHelpers.js`; no local copy. |
| `getOwnedDocument` | `utils/routeHelpers.js` | 12 | Canonical implementation. No exact route-local copy found. |
| `getOwnedDocument` | `routes/exams.js` | 6 | Imported from `utils/routeHelpers.js`; no local copy. |
| `getOwnedDocument` | `routes/flashcards.js` | 6 | Imported from `utils/routeHelpers.js`; no local copy. |
| `getOwnedDocument` equivalent | `routes/documents.js` | 201 | Drifted helper named `getAuthorizedDocument`; throws HTTP errors instead of returning `{ status, error }`, accepts full `user`, permits admins, accepts query options, and reconciles processing state. |
| `getOwnedDocument` equivalent | `routes/telegram.js` | 127 | Drifted helper named `getOwnedReadyDocument`; throws HTTP errors, selects Telegram-specific document fields, and requires completed processing status. |
| `getOwnedExamRecord` | `utils/routeHelpers.js` | 29 | Canonical implementation. No route-local copy found. |
| `getOwnedExamRecord` | `routes/exams.js` | 6 | Imported from `utils/routeHelpers.js`; no local copy. |
| `getOwnedExamRecord` | `routes/exports.js` | 9 | Imported from `utils/routeHelpers.js`; no local copy. |

Conclusion: the original three copy-pasted helpers have already been centralized. Current drift is in equivalent ownership/error helpers that have route-specific behavior.

## Section 3: Any newly discovered duplication not in the original list

| Helper/pattern | File | Line | Identical or drifted |
| --- | --- | ---: | --- |
| `createHttpError` | `routes/documents.js` | 192 | Functionally identical to `routes/telegram.js:27`; formatting differs only in the `if (code)` block. |
| `createHttpError` | `routes/telegram.js` | 27 | Functionally identical to `routes/documents.js:192`; formatting differs only in the `if (code)` block. |
| `jsonError` | `routes/documents.js` | 219 | Drifted. Always returns `error?.message || fallbackMessage`; does not include `error.code`. |
| `jsonError` | `routes/telegram.js` | 34 | Drifted. Hides 500-level messages behind fallback text and includes `payload.code` when present. |
| Ownership helper pattern | `routes/exams.js` | 112 | `getOwnedExamAttempt`; resource-specific ownership helper returning `{ status, error }` or `{ attempt }`. Similar shape to export/flashcard helpers but not identical. |
| Ownership helper pattern | `routes/flashcards.js` | 12 | `getOwnedFlashcardSet`; resource-specific ownership helper returning `{ status, error }` or `{ flashcardSet }`. Similar shape to exam/export helpers but not identical. |
| Ownership helper pattern | `routes/exports.js` | 11 | `getOwnedAttempt`; resource-specific ownership helper returning `{ status, error }` or `{ attempt }`. Similar shape to exam helper but simpler. |
| Ownership helper pattern | `routes/exports.js` | 27 | `getOwnedExportArtifact`; resource-specific ownership helper returning `{ status, error }` or `{ artifact }`. Similar shape to other ownership helpers but not identical. |
| Test helper `createTestApp` | `routes/admin.test.js` | 7 | Same test-helper name as `routes/telegram.test.js:214`, but different dependencies and routes. |
| Test helper `createTestApp` | `routes/telegram.test.js` | 214 | Same test-helper name as `routes/admin.test.js:7`, but different dependencies and routes. |
| Test helper `request` | `routes/admin.test.js` | 24 | Same test-helper name as `routes/telegram.test.js:230`, but signature/body differ. |
| Test helper `request` | `routes/telegram.test.js` | 230 | Same test-helper name as `routes/admin.test.js:24`, but signature/body differ. |
| Local query helper | `routes/admin.js` | 55 | `getQueryValue` is duplicated inside the same file at lines 830, 1429, and 2993. This is same-file duplication, not cross-route duplication. |

## Section 4: Proposed shape for `utils/routeHelpers.js`

Signatures only for review:

```js
export function normalizePositiveInteger(value, fallback, { min = 1, max = 100 } = {});

export function createHttpError(statusCode, message, code);

export function jsonError(res, error, fallbackMessage, options = {});

export async function getOwnedDocument(prisma, documentId, userId, queryOptions = {});

export async function getAuthorizedDocument(prisma, documentId, user, queryOptions = {});

export async function getOwnedReadyDocument(prisma, documentId, userId, queryOptions = {});

export async function getOwnedExamRecord(prisma, examId, userId, queryOptions = {});

export async function getOwnedExamAttempt(prisma, attemptId, userId, queryOptions = {});

export async function getOwnedFlashcardSet(prisma, setId, userId, queryOptions = {});

export async function getOwnedExportArtifact(prisma, artifactId, userId, queryOptions = {});
```
