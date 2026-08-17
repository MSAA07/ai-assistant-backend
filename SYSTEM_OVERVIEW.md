# System Overview (Backend)

This document describes the current implemented backend architecture.

## Product-Aligned Model

The backend currently supports:

- Study Hub Library
- Study Hub Document
- guided post-upload selection and progress handoff from Home
- study activity APIs

The canonical user-facing route model is owned by the frontend, but the backend owns the data contracts behind that model.

## Lifecycle Ownership

Document processing lifecycle:

- source: `Document.processingStatus`
- values: `queued`, `processing`, `complete`, `failed`
- fields: `processingJobId`, `processingError`, `processedAt`

Job execution lifecycle:

- source: `Job.status`
- values: `queued`, `running`, `succeeded`, `failed`
- fields: `progressPct`, `retryCount`, `workerId`, `leaseExpiresAt`, `lastHeartbeatAt`

Generation lifecycle:

- source: `DocumentGeneration.status`
- values: `not_requested`, `queued`, `running`, `complete`, `failed`
- fields: `jobId`, `options`, `output`, `errorMessage`, `generatedAt`, `isLatest`

Compatibility mirrors:

- `Document.summary`
- `Document.flashcards`
- `Document.examQuestions`

Those mirror fields remain in the serialized document contract even though canonical generation ownership lives on `DocumentGeneration`.

## Runtime Components

API server:

- `server.js`
- mounts Better Auth under `/api/auth/*`
- mounts REST routes under `/api/*` (user profile/export at `/api/user`, documents at `/api`, study-data sub-routers at `/api/flashcard`, `/api/exam`, `/api/exports`, Telegram delivery at `/api/telegram` and `/api/document/:id/telegram/*`, admin at `/api/admin`, admin QA at `/api/admin/qa`)
- runs schema and document-state reconciliation on startup
- starts the in-memory admin QA scheduler after the API listener is live
- uses one shared allowed-origin source for Better Auth trusted origins and Express CORS
- Better Auth email/password verification emails are sent through the configured transactional email provider using `utils/authEmailTemplates.js`
- `/auth/verify-email` hands verification to Better Auth before the frontend redirect; `/auth/reset-password` redirects the unconsumed reset token directly to the allowed frontend action URL so the user can submit a new password

Worker:

- `worker.js`
- polls queued jobs every 2 seconds
- claims jobs through `SELECT ... FOR UPDATE SKIP LOCKED`
- maintains heartbeats and leases
- retries retryable failures and fails non-retryable ones
- sweeps stale jobs

Persistence:

- PostgreSQL via Prisma
- Cloudflare R2 when configured, local absolute-path fallback otherwise
- every Prisma model or persisted-contract change requires a migration

Extraction:

- `utils/extractionPipeline.js`
- PDF via `pdf-parse` (free, fast)
- If `pdf-parse` returns fewer than 50 characters (scanned/image-based PDF), Mistral OCR fallback runs automatically via `utils/mistralOcr.js`
- DOCX via `mammoth`
- PPTX via `scripts/extract_pptx.py`
- 200 page/slide limit enforced — files over this limit are rejected before any API call with error code `document_too_long`
- extracted excerpt text is sanitized before `DocumentExcerpt` rows are inserted so invalid UTF-8 control bytes cannot be persisted

Generation:

- `utils/generationPipeline.js`
- `utils/studyMaterials.js`
- `utils/modelRoutingPolicy.js`
- prompt-engineering rollout is complete in the current backend path
- shared prompt framework is implemented for summary, flashcards, and mock exam
- default summary, flashcard, and mock exam generation keep the existing shared prompt path
- `GENERATION_PIPELINE_V2` enables the summary study-guide pipeline: full-document signal extraction, global chapter-map analysis, structured synthesis, exam optimization, and format enforcement
- large default-path documents can use sampled excerpts; V2 summaries analyze all usable excerpts through bounded extraction chunks before one global synthesis
- weak documents reduce scope or count instead of inventing unsupported detail
- model is chosen per request from routing policy
- current policy: lower-cost model by default, stronger-model upgrade first for mock exams on entitled tiers
- free, pro, and premium stay on the same backend generation endpoints and worker path; tier differences are routing-policy and limits decisions, not separate APIs
- prompt-layer rollout and routing-policy rollout can be enabled or rolled back independently with feature flags

## Processing Pipelines

Extraction pipeline:

`POST /api/upload -> Job(extract_document) -> worker -> DocumentExcerpt rows -> Document complete`

Behavior:

- upload creates the `Document` and extraction `Job`
- the document starts at `processingStatus=queued`
- the Home guided upload step can poll `GET /api/jobs/:id` plus `GET /api/document/:id` while extraction is still running
- the worker moves the document to `processing` when the job is claimed
- extracted text is sanitized, then stored as `DocumentExcerpt` rows
- success moves the document to `complete`
- permanent failure moves the document to `failed`

Generation pipeline:

`POST /api/document/:id/generations -> Job(generate_*) -> worker -> DocumentGeneration -> canonical records + document mirrors`

Behavior:

- generation is blocked until extraction is `complete`
- one latest `DocumentGeneration` row is maintained per feature type
- matching completed generations can be reused
- matching active generations can be reused
- active conflicting option sets return `409`
- successful flashcard/exam generation updates canonical study records and document mirrors
- regeneration accepts optional grounded guidance through `options.regenerationGuidance`
- prompt versions are persisted for released generations in `Job.result` and `UsageEvent.metadata`
- benchmark metadata and rollout metadata are attached through existing internal JSON metadata, not new schema
- evaluator outcomes for benchmark runs can be attached later through the admin evaluation flow
- large sampled/default-path generations reserve and reconcile prompt-token usage against prepared source material
- V2 summary generations reserve against all usable excerpt chunks and reconcile actual usage across extraction, analysis, synthesis, optimization, and formatting calls
- weak-certainty references are resolved during source preparation:
  - `Page N` for reliable PDF anchors
  - `Slide N` for reliable PPT/PPTX anchors
  - extracted `Section: ...` labels when certainty is weak but structure is reliable
  - omitted references when no reliable structure exists
- DOCX synthetic chunks are internal anchors only and are not documented or treated as real pages

Telegram delivery pipeline:

`POST /api/telegram/link-token -> Telegram /start webhook -> TelegramConnection -> POST /api/document/:id/telegram/*/send -> TelegramDeliveryLog`

Behavior:

- user study delivery never uses `TELEGRAM_ADMIN_CHAT_ID`
- users connect Telegram through a short-lived one-time deep-link token; raw StudyMaxing user ids are not placed in Telegram start payloads
- `/api/telegram/webhook` validates the Telegram secret-token header before processing `/start`
- flashcard and exam sends require auth, document ownership, complete `Document.processingStatus`, an active Telegram connection, and ready canonical records
- send routes read canonical `FlashcardSet` / `FlashcardCard` and `ExamRecord` / `ExamQuestion`; they do not queue generation, mutate `DocumentGeneration`, or create exam attempts
- delivery usage is stored in `TelegramDeliveryLog` for admin visibility only; Telegram answers/results are not saved

Admin QA pipeline:

`POST /api/admin/qa/{health|pipeline|full} -> in-memory runner -> target backend -> QaRun/QaRunResult history`

Behavior:

- all QA routes require an authenticated admin session
- `POST /api/admin/qa/health` runs eight no-AI checks for backend, database, R2 storage, OpenAI, Mistral, Resend, auth, and admin endpoint reachability
- `POST /api/admin/qa/pipeline` signs in as `qa@studymaxing.com`, uploads `qa-pipeline-test.pdf`, waits for extraction/generation, exports a PDF, deletes the QA document, and signs out
- `POST /api/admin/qa/full` supports `mode=optimized` and `mode=full`; both run the full file-type and edge-case suite across PDF, DOCX, PPTX, Arabic OCR paths, oversized rejection, corrupt-file handling, PDF export, and admin health
- health, pipeline, and full tiers have independent in-memory cooldowns of 1 minute, 3 minutes, and 5 minutes respectively; optimized full QA shares the full tier cooldown
- only one QA run can execute at a time, and `GET /api/admin/qa/progress` returns the active tier label, elapsed time, estimated remaining time, and per-test progress
- `GET /api/admin/qa/history` returns persisted run history with per-test speed verdicts, thresholds, duration, cost, trigger source, and failure reports
- `GET /api/admin/qa/schedule` and `POST /api/admin/qa/schedule` read/write `QaScheduleConfig`; the current automatic monitor runs health checks only
- scheduled health failures can send a raw Telegram admin alert through `TELEGRAM_ADMIN_CHAT_ID`
- QA fixture generation lives in `scripts/generate-qa-files.js` and `scripts/generate-qa-pdf.js`

## API Surface

Core Study Hub APIs:

- `GET /api/user/me`
- `POST /api/upload`
- `GET /api/document/:id`
- `PATCH /api/document/:id`
- `DELETE /api/document/:id`
- `GET /api/document/:id/excerpts`
- `POST /api/document/:id/generations`
- `GET /api/document/:id/generations`
- `GET /api/jobs/:id`

Legacy compatibility activity APIs:

- `POST /api/flashcard/progress`
- `POST /api/exam/attempt`

Canonical study activity APIs:

- `GET /api/document/:id/flashcard-sets`
- `GET /api/flashcard-sets/:setId`
- `PATCH /api/flashcard-sets/:setId/cards/:cardId/state`
- `GET /api/flashcard-sets/:setId/incorrect-session`
- `GET /api/document/:id/exams`
- `GET /api/exams/:examId`
- `POST /api/exams/:examId/attempts`
- `GET /api/exams/:examId/attempts/current`
- `POST /api/exam-attempts/:attemptId/save`
- `POST /api/exam-attempts/:attemptId/submit`
- `POST /api/exam-attempts/:attemptId/restart`
- `GET /api/exam-attempts/:attemptId/review`
- `POST /api/exports/exams`
- `GET /api/exports`
- `GET /api/exports/:id`
- `GET /api/exports/:id/download`

Telegram APIs:

- `GET /api/telegram/status`
- `POST /api/telegram/link-token`
- `DELETE /api/telegram/link`
- `POST /api/telegram/webhook`
- `POST /api/document/:id/telegram/flashcards/send`
- `POST /api/document/:id/telegram/exam/send`

Admin coverage:

- users
- files
- sessions
- analytics
- storage
- usage and cost reporting
- per-user limits
- anomaly resolution
- feature flags and flag audit
- benchmark/evaluation annotation for completed generation jobs
- read-only Telegram connection and delivery usage indicators
- QA history, active progress, per-tier run endpoints, and automatic health monitor configuration

## Current Prisma Model Set

Current schema models:

- `User`
- `Session`
- `Account`
- `Verification`
- `Document`
- `FlashcardProgress`
- `ExamAttempt`
- `FlashcardSet`
- `FlashcardCard`
- `FlashcardCardState`
- `ExamRecord`
- `ExamQuestion`
- `ExportArtifact`
- `AuditLog`
- `DocumentExcerpt`
- `DocumentGeneration`
- `Job`
- `JobStageEvent`
- `FeatureFlag`
- `FeatureFlagAssignment`
- `FeatureFlagAuditLog`
- `UserLimit`
- `UsageCapConfig`
- `CostAnomalyAlert`
- `AdminAlert`
- `UsageEvent`
- `ModelUsageEvent`
- `TelegramConnection`
- `TelegramLinkToken`
- `TelegramDeliveryLog`
- `QaRun`
- `QaRunResult`
- `QaScheduleConfig`

Current migration folders:

- `20260216073943_init`
- `20260302194206_add_jobs_flags_limits_usage_excerpts`
- `20260308000000_document_processing_lifecycle_stabilization`
- `20260309000000_generation_architecture_f2`
- `20260310010000_phase2_foundations_m1`
- `20260427000000_phase1_model_usage_ledger`
- `20260427010000_phase2_caps_and_allowances`
- `20260427020000_phase3_job_stage_observability`
- `20260427030000_phase5_admin_email_alerts`
- `20260427040000_phase6_admin_controls`
- `20260511000000_add_telegram_delivery`
- `20260606000000_add_qa_run_history`
- `20260607000000_add_qa_tier`

## Environment Variables

Required:

- `DATABASE_URL`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_BASE_URL` or `BETTER_AUTH_URL`
- `OPENAI_API_KEY`
- `RESEND_API_KEY`
- `MISTRAL_API_KEY`

Optional core operations:

- `ADMIN_EMAILS`
- `FRONTEND_ORIGINS`
- `QA_STAGING_API_BASE_URL`
- `QA_PRODUCTION_API_BASE_URL`
- `QA_API_BASE_URL`
- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`

Optional auth email and callbacks:

- `AUTH_EMAIL_PROVIDER` (`resend` default)
- `AUTH_EMAIL_FROM_EMAIL`
- `AUTH_EMAIL_FROM_NAME` (`Studymaxing` default)
- `AUTH_EMAIL_REPLY_TO`
- `AUTH_EMAIL_SUPPORT_EMAIL`
- `AUTH_EMAIL_APP_URL`

Optional alerting:

- `ALERTS_ENABLED` (`true` default)
- `ADMIN_ALERT_EMAIL`
- `ALERT_FROM_EMAIL`
- `ALERT_DAILY_COST_THRESHOLD_USD` (`10` default)
- `ALERT_USER_COST_THRESHOLD_USD` (falls back to 80% of active user cost cap)
- `ALERT_SPIKE_MULTIPLIER` (`3` default)
- `ALERT_FAILED_JOB_THRESHOLD` (`3` default)
- `ALERT_DEDUP_WINDOW_MINUTES` (`60` default)

Optional Telegram integration:

- `TELEGRAM_BOT_USERNAME`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_WEBHOOK_URL`
- `TELEGRAM_ADMIN_CHAT_ID` (admin alerts only; not used for user study delivery)

OCR:

- `MISTRAL_API_KEY` must be set on BOTH backend and worker Railway services for scanned PDF OCR fallback

Auth email callback targets are backend-owned `/auth/verify-email` and `/auth/reset-password` bridge URLs. The final frontend destination can still be controlled by frontend env overrides or `AUTH_EMAIL_APP_URL`.

## Maintenance Triggers

Update this file when any of these change:

- lifecycle ownership
- route contracts
- worker claim/retry/recovery behavior
- canonical study records or mirror-field behavior
- Prisma model set or migration history
- model-routing policy or benchmark rules
- rollout validation or traceability requirements
- final execution brief or locked implementation decisions
- prompt-version persistence or weak-reference resolution behavior
- Telegram linking, webhook, delivery, or admin usage contracts
- admin QA tiers, cooldowns, scheduler behavior, persisted QA history, or QA fixtures

Last Updated: June 7, 2026
