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
- mounts REST routes under `/api/*`
- runs schema and document-state reconciliation on startup
- uses one shared allowed-origin source for Better Auth trusted origins and Express CORS
- Better Auth email/password verification emails are sent through the configured transactional email provider

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
- extracted excerpt text is sanitized before `DocumentExcerpt` rows are inserted so invalid UTF-8 control bytes cannot be persisted

Generation:

- `utils/generationPipeline.js`
- `utils/studyMaterials.js`
- `utils/modelRoutingPolicy.js`
- prompt-engineering rollout is complete in the current backend path
- shared prompt framework is implemented for summary, flashcards, and mock exam
- large documents can use a two-step flow: sampled excerpts first, then a grounded learning-content map, then feature generation
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
- prompt versions are persisted for released generations in `Job.result` and `UsageEvent.metadata`
- benchmark metadata and rollout metadata are attached through existing internal JSON metadata, not new schema
- evaluator outcomes for benchmark runs can be attached later through the admin evaluation flow
- large sampled generations reserve and reconcile prompt-token usage across both the analysis pass and the final generation pass
- weak-certainty references are resolved during source preparation:
  - `Page N` for reliable PDF anchors
  - `Slide N` for reliable PPT/PPTX anchors
  - extracted `Section: ...` labels when certainty is weak but structure is reliable
  - omitted references when no reliable structure exists
- DOCX synthetic chunks are internal anchors only and are not documented or treated as real pages

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
- benchmark/evaluation annotation for completed generation jobs

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
- model-routing policy or benchmark rules
- rollout validation or traceability requirements
- final execution brief or locked implementation decisions
- prompt-version persistence or weak-reference resolution behavior

Last Updated: March 28, 2026
