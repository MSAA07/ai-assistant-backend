# Project Structure (Backend)

This file maps the current backend repository structure.

## Root Tree

```text
ai-assistant-backend/
|-- AGENTS.md
|-- agent.md
|-- README.md
|-- PHASE1_PROMPT_ENGINEERING.md
|-- PHASE3_MODEL_ROUTING_BENCHMARK.md
|-- PHASE4_ROLLOUT_VALIDATION.md
|-- PHASE5_FINAL_EXECUTION_BRIEF.md
|-- SYSTEM_OVERVIEW.md
|-- PROJECT_STRUCTURE.md
|-- DEPLOY_TRIGGER.md
|-- package.json
|-- Dockerfile
|-- railway.toml
|-- nixpacks.toml
|-- requirements.txt
|-- server.js
|-- worker.js
|-- auth.js
|-- backfill-storage.js
|-- reset-db.js
|-- docs/
|-- middleware/
|-- prisma/
|-- routes/
|-- scripts/
|-- tests/
`-- utils/
    |-- extractionPipeline.js
    `-- mistralOcr.js
```

## Top-Level Responsibilities

- `server.js`: API entry point and startup reconciliation
- `worker.js`: extraction/generation worker, retries, heartbeats, stale-job recovery
- `auth.js`: Better Auth configuration and email-template wiring
- `backfill-storage.js`: recompute `User.storageUsed`
- `reset-db.js`: destructive non-production reset helper

## Routes

- `routes/user.js`: user profile bootstrap (`GET /me`), allowance (`GET /allowance`), account data export (`GET /export`)
- `routes/documents.js`: upload, read, rename, delete, excerpts, generation queueing
- `routes/jobs.js`: job execution lifecycle polling used by the guided upload flow and study surfaces
- `routes/flashcards.js`: legacy flashcard progress plus canonical flashcard-set routes
- `routes/exams.js`: legacy exam attempt plus canonical exam and attempt routes
- `routes/exports.js`: export artifact routes
- `routes/telegram.js`: Telegram account linking, webhook handling, and study-material delivery routes
- `routes/admin.js`: admin APIs for paginated/bulk users, support login, user export/erasure, Security & Access, unified Operations incidents, job retry/queue inspection, analytics, usage, costs, limits, anomalies, feature flags, and generation evaluation annotation
- `routes/qa.js`: admin-only QA tiers, active progress, persisted history, per-tier cooldowns, and automatic health-monitor scheduling

## Middleware

- `middleware/auth.js`: `requireAuth`
- `middleware/adminGuard.js`: `requireAdmin`
- `middleware/rateLimit.js`: generation throttling and shared in-memory rate limiting
- `middleware/featureFlag.js`: feature-flag request helpers

## Core Utilities

Lifecycle and serialization:

- `utils/documentStatus.js`
- `utils/documentGeneration.js`
- `utils/jobQueue.js`

Worker processors:

- `utils/extractionPipeline.js`
- `utils/mistralOcr.js`: Mistral OCR fallback for scanned/image-based PDFs — uploads file to Mistral API, gets signed URL, runs OCR, deletes file, returns plain text
- `utils/generationPipeline.js`: generation worker pipeline, routing resolution, prompt/cost trace persistence, default-path token reconciliation, and V2 summary source budgeting
- `utils/studyMaterials.js`: shared prompt framework, feature prompts, flagged V2 summary study-guide pipeline, weak-reference resolution, and output normalization
- `utils/modelRoutingPolicy.js`: per-tier execution policy, quality-mode access, stronger-model upgrade rules, and fallback policy

Canonical study-record support:

- `utils/phase2Backfill.js`
- `utils/phase2Flashcards.js`
- `utils/phase2Exams.js`
- `utils/phase2Exports.js`
- `utils/phase2GenerationRecords.js`
- `utils/phase2SourceRefs.js`

Operational support:

- `utils/storage.js`
- `utils/limits.js`
- `utils/frontendOrigins.js`
- `utils/authCookieAttributes.js`: selects cross-site-safe cookies for HTTPS deployments while preserving local HTTP development
- `utils/featureFlags.js`
- `utils/costGuard.js`
- `utils/authEmailTemplates.js`
- `utils/auditLog.js`
- `utils/sentry.js`
- `utils/sentryIssues.js`: staging-filtered Sentry REST polling with a bounded TTL cache and stale-if-error behavior
- `utils/issuesFeed.js`: source-isolated incident aggregation, linked job-alert deduplication, query-bounded pagination, KPIs, and lifecycle persistence
- `utils/serializers.js`
- `utils/telegramDelivery.js`: Telegram Bot API delivery helpers, deep-link token helpers, message/poll formatting, and env validation

## Prisma Layer

- `prisma/schema.prisma`: current schema
- `prisma/seed.js`: seed entry
- `prisma/migrations/`: migration history

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
- `20260831000000_add_session_impersonation`: adds Better Auth's acting-admin identity field to impersonated sessions.
- `20260901000000_add_audit_log_diff`: adds nullable JSON `previousValue` and `newValue` columns to admin audit entries; no legacy backfill is required.
- `20260902000000_add_incident_lifecycle`: adds source-agnostic local incident lifecycle state for Sentry, jobs, admin alerts, and cost anomalies.

## Scripts

- `scripts/extract_pptx.py`: PPTX extraction helper
- `scripts/backfill-phase2-canonical.js`: legacy-to-canonical backfill and reconciliation
- `scripts/run-with-prisma.js`: env-aware startup wrapper for safe Prisma schema application
- `scripts/print-auth-config.js`: prints Better Auth base URL and shared allowed-origin config
- `scripts/diagnose_unicode.js`: unicode diagnostics helper for extracted text issues
- `scripts/setup-telegram-webhook.js`: registers the Telegram webhook using `TELEGRAM_WEBHOOK_URL` and `TELEGRAM_WEBHOOK_SECRET`
- `scripts/send-telegram-test-alert.js`: sends a Telegram admin-alert test message
- `scripts/send-daily-admin-digest.js`: sends or dry-runs the admin digest
- `scripts/generate-qa-files.js`: creates deterministic QA fixtures used by admin QA
- `scripts/generate-qa-pdf.js`: creates the pipeline PDF fixture used by admin QA

## Structure Notes

- `Document`, `DocumentGeneration`, and `Job` are distinct ownership layers and should be documented separately.
- Canonical flashcard and exam records are Prisma-backed and coexist with document mirror fields.
- `POST /api/upload` and worker processing still use `/tmp/uploads` during local/temp file handling before R2 or local-path persistence is finalized.
- `utils/extractionPipeline.js` sanitizes extracted excerpt content before `DocumentExcerpt` persistence so invalid UTF-8 control bytes do not reach PostgreSQL.
- Prompt/version, rollout, and benchmark traceability reuse existing JSON metadata surfaces and do not add new Prisma models.
- Telegram user study delivery is linked per user through `TelegramConnection` and logged through `TelegramDeliveryLog`; `TELEGRAM_ADMIN_CHAT_ID` remains admin-alert-only.
- Admin QA run history is persisted in `QaRun` and `QaRunResult`; automatic health monitor state is persisted in `QaScheduleConfig`, while active progress and cooldowns remain in-memory per API process.
- Backend phase markdown files in the repo root are archival rollout records. Use `SYSTEM_OVERVIEW.md` and `PROJECT_STRUCTURE.md` for live runtime truth.

Last Updated: June 7, 2026
