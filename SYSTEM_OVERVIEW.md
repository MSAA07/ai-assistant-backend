# System Overview (Backend)

This document describes the current implemented backend architecture.

## Product-Aligned Model

The backend currently supports:

- Study Hub Library
- Study Hub Document
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
- mounts REST routes under `/api/*`
- runs schema and document-state reconciliation on startup

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

Extraction:

- `utils/extractionPipeline.js`
- PDF via `pdf-parse`
- DOCX via `mammoth`
- PPTX via `scripts/extract_pptx.py`

Generation:

- `utils/generationPipeline.js`
- `utils/studyMaterials.js`
- current model constant: `gpt-4o-mini`

## Processing Pipelines

Extraction pipeline:

`POST /api/upload -> Job(extract_document) -> worker -> DocumentExcerpt rows -> Document complete`

Behavior:

- upload creates the `Document` and extraction `Job`
- the document starts at `processingStatus=queued`
- the worker moves the document to `processing` when the job is claimed
- extracted text becomes `DocumentExcerpt` rows
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

## Current Prisma Model Set

Current schema models:

- `User`
- `Session`
- `Account`
- `Verification`
- `Document`
- `DocumentExcerpt`
- `DocumentGeneration`
- `Job`
- `FlashcardProgress`
- `ExamAttempt`
- `FlashcardSet`
- `FlashcardCard`
- `FlashcardCardState`
- `ExamRecord`
- `ExamQuestion`
- `ExportArtifact`
- `AuditLog`
- `FeatureFlag`
- `FeatureFlagAssignment`
- `FeatureFlagAuditLog`
- `UserLimit`
- `CostAnomalyAlert`
- `UsageEvent`

Current migration folders:

- `20260216073943_init`
- `20260302194206_add_jobs_flags_limits_usage_excerpts`
- `20260308000000_document_processing_lifecycle_stabilization`
- `20260309000000_generation_architecture_f2`
- `20260310010000_phase2_foundations_m1`

## Maintenance Triggers

Update this file when any of these change:

- lifecycle ownership
- route contracts
- worker claim/retry/recovery behavior
- canonical study records or mirror-field behavior
- Prisma model set or migration history

Last Updated: March 23, 2026
