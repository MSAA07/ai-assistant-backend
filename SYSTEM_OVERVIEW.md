# System Overview

This document describes the current backend architecture for the AI Study Assistant after the Study Hub redesign.

## Product-Aligned View

The current product is organized around three Study Hub layers:

1. Study Hub Library
2. Study Hub Document
3. Activity Modes

The canonical user flow is:

`Home -> Upload document -> Choose generation options -> Processing state -> Study Hub Library -> Study Hub Document -> Activity Mode -> Summary | Flashcards | Mock Exam`

The backend does not own the frontend screens, but it does own the data contracts and background processing that make each screen work.

## Study Hub Layers and Backend Contracts

### Study Hub Library

Purpose:
- Show a grid of uploaded materials
- Surface extraction/generation readiness without loading full activity data
- Support document entry and document deletion

Backend contract:
- `GET /api/user/me`
- Returns the authenticated user plus their documents ordered by newest first
- Each document includes `processingStatus`, `processingJobId` when active, and a per-feature `generationState`
- Document cards are intentionally lightweight and derive their visible title from `originalName`

### Study Hub Document

Purpose:
- Present a single selected document
- Show feature entry cards for Summary, Flashcards, and Mock Exam
- Reflect the state of each feature card: `not_requested`, `queued`, `running`, `complete`, or `failed`

Backend contract:
- `GET /api/document/:id`
- `GET /api/document/:id/generations`
- `POST /api/document/:id/generations`

Notes:
- The backend serializes the selected document with `generationState.summary`, `generationState.flashcards`, and `generationState.exam`
- Feature cards should be driven directly by those states.

### Activity Modes

Purpose:
- Enter the actual study experience for a generated feature
- Keep navigation minimal: library -> document -> activity

Backend contract:
- Summary reader: `GET /api/document/:id`
- Flashcards: `GET /api/document/:id/flashcard-sets`, `GET /api/flashcard-sets/:setId`, `PATCH /api/flashcard-sets/:setId/cards/:cardId/state`
- Mock exam: `GET /api/document/:id/exams`, `GET /api/exams/:examId`, attempt lifecycle routes, and exam export routes

## Runtime Stack

- Runtime: Node.js 18+ (Docker image uses Node 20)
- HTTP framework: Express 4
- Auth: Better Auth
- Database: PostgreSQL via Prisma
- AI generation: OpenAI `gpt-4o-mini`
- Storage: Cloudflare R2 with local fallback
- Background work: `worker.js` with DB-backed queue, leases, heartbeats, retries, and stale-job recovery

## Runtime Components

### API server (`server.js`)

- Mounts REST endpoints under `/api/*`
- Mounts Better Auth handlers at `/api/auth/*`
- Applies CORS, authentication, and admin authorization
- Normalizes document-processing state on startup

### Worker (`worker.js`)

- Polls the queue every 2 seconds
- Processes extraction jobs and generation jobs
- Maintains a lease heartbeat while work is active
- Requeues retryable failures and permanently fails non-retryable work
- Runs stale-job recovery and anomaly sweeps on intervals

### Database (PostgreSQL)

Stores:
- auth data
- users and limits
- documents and excerpts
- background jobs
- generation history
- canonical flashcard and exam records
- attempts, exports, usage, anomalies, audit logs, and feature flags

### Object storage

- Uploaded files are stored in Cloudflare R2 when configured
- Local-path fallback is used when R2 environment variables are absent

## Processing Pipelines

### Extraction pipeline

`Upload -> Job(extract_document) -> Worker -> DocumentExcerpt rows -> Document complete`

Detailed behavior:
- `POST /api/upload` creates the `Document` and extraction `Job` in one transaction
- `Document.processingStatus` starts at `queued`
- When the worker claims the job, the document moves to `processing`
- Extracted content is stored as `DocumentExcerpt` rows
- On success, the document moves to `complete` and `processedAt` is populated
- On permanent failure, the document moves to `failed` and `processingError` is exposed

Progress reporting:
- Upload returns `jobId` and `documentId`
- `GET /api/jobs/:id` returns `status`, `progressPct`, `documentId`, `generationId`, `result`, and `errorMessage`
- `GET /api/document/:id` exposes document-level processing state for library and document views

### Generation pipeline

`POST /api/document/:id/generations -> Job(generate_*) -> Worker -> DocumentGeneration -> canonical records + document mirrors`

Detailed behavior:
- Generation is blocked until document extraction is `complete`
- One latest `DocumentGeneration` row is maintained per feature type
- Supported feature types: `summary`, `flashcards`, `exam`
- Supported statuses: `not_requested`, `queued`, `running`, `complete`, `failed`
- If the latest generation already matches the requested options, the backend reuses that generation instead of queueing duplicate work
- If matching work is already `queued` or `running`, the backend returns the active generation/job instead of creating another one
- If a different option set is already active for the same feature, the backend returns `409`

Guided regeneration:
- Regeneration is explicit through `regenerate: true`
- All feature types accept optional `options.regenerationGuidance`
- Supported guidance fields:
  - `reasonKey`: `missing_parts`, `not_comprehensive_enough`, `too_short`, `too_generic`
  - `customInstruction`: free-form instruction capped at 500 characters
- The worker passes that guidance into the generation prompt while keeping output grounded in extracted study material

Completion behavior:
- Summary completion updates `Document.summary`
- Flashcard completion updates `Document.flashcards` and canonical `FlashcardSet` / `FlashcardCard` records
- Exam completion updates `Document.examQuestions` and canonical `ExamRecord` / `ExamQuestion` records
- Current frontend reads remain compatible because document mirror fields stay populated

## Navigation and State Model

The redesigned product intentionally uses a simplified navigation model.

Documented flow should assume:
- entry from Home into upload
- a dedicated processing state while extraction or generation is in progress
- a library shelf for selecting a document
- a document-level feature chooser
- activity modes entered from that document view

Documentation should stay aligned with the current product model and canonical user flow.

## API Surface

### Health

- `GET /api/health`

### Auth

- `POST /api/auth/sign-up/email`
- `POST /api/auth/sign-in/email`
- `GET /api/auth/get-session`
- `POST /api/auth/sign-out`

### Library and document routes

- `GET /api/user/me`
- `POST /api/upload`
- `GET /api/document/:id`
- `DELETE /api/document/:id`
- `GET /api/document/:id/excerpts`
- `POST /api/document/:id/generations`
- `GET /api/document/:id/generations`
- `GET /api/jobs/:id`

### Flashcard routes

- `POST /api/flashcard/progress`
- `GET /api/document/:id/flashcard-sets`
- `GET /api/flashcard-sets/:setId`
- `PATCH /api/flashcard-sets/:setId/cards/:cardId/state`

### Exam routes

- `POST /api/exam/attempt`
- `GET /api/document/:id/exams`
- `GET /api/exams/:examId`
- `POST /api/exams/:examId/attempts`
- `GET /api/exams/:examId/attempts/current`
- `POST /api/exam-attempts/:attemptId/save`
- `POST /api/exam-attempts/:attemptId/submit`
- `POST /api/exam-attempts/:attemptId/restart`
- `GET /api/exam-attempts/:attemptId/review`

### Export routes

- `POST /api/exports/exams`
- `GET /api/exports`
- `GET /api/exports/:id`
- `GET /api/exports/:id/download`

### Admin routes

Admin coverage includes:
- user and session management
- file operations
- analytics and storage reporting
- usage and cost reporting
- per-user limits
- cost anomalies
- feature flags and feature-flag audit logs

## Data Model Summary

Current schema models (23):
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
- `UsageEvent`
- `UserLimit`
- `CostAnomalyAlert`
- `FeatureFlag`
- `FeatureFlagAssignment`
- `FeatureFlagAuditLog`

Lifecycle ownership:
- Extraction lifecycle: `Document.processingStatus`, `processingJobId`, `processingError`, `processedAt`
- Worker execution state: `Job.status`, `workerId`, `leaseExpiresAt`, `lastHeartbeatAt`, `retryCount`, `progressPct`
- Generation lifecycle/history: `DocumentGeneration.status`, `isLatest`, `options`, `output`, `errorMessage`, `generatedAt`
- Flashcard activity state: `FlashcardSet`, `FlashcardCard`, `FlashcardCardState`
- Exam activity state: `ExamRecord`, `ExamQuestion`, `ExamAttempt`, `ExportArtifact`

## Worker Safety and Recovery

- Uses `SELECT ... FOR UPDATE SKIP LOCKED` to claim queued jobs
- Sends lease heartbeats while jobs are active
- Sweeps stale jobs on startup and every 15 seconds
- Retries transient failures until `maxRetries`
- Marks non-retryable failures immediately
- Backfills document-processing state on worker startup before claiming work

## Deployment Notes

Staging:
- Railway backend: `https://ai-assistant-backend-staging.up.railway.app`
- Branch: `stage`

Production:
- Railway backend: `https://ai-assistant-backend-production-ddf0.up.railway.app`
- Branch: `production`

Important environment variables:
- `DATABASE_URL`
- `OPENAI_API_KEY`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_BASE_URL` or `BETTER_AUTH_URL`
- `ADMIN_EMAILS`
- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`

## Maintenance

Update this file when any of the following changes:
- route contracts
- job lifecycle behavior
- schema models or relationships
- deployment endpoints or required environment variables
- the Study Hub screen hierarchy or canonical user flow

Last Updated: March 11, 2026

