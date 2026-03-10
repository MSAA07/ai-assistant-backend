# System Overview

This document describes the backend architecture, API surface, and data flow for the AI Study Assistant.

## Current Stack

- Runtime: Node.js 18+ (Docker image uses Node 20)
- Framework: Express 4
- Auth: Better Auth
- Database: PostgreSQL via Prisma
- AI: OpenAI (`gpt-4o-mini`) for on-demand generations
- Storage: Cloudflare R2 (S3-compatible) with local fallback
- Worker: `worker.js` with DB-backed queue, leases, retries, and stale-job recovery

## Runtime Components

1. API server (`server.js`)
- Serves REST endpoints under `/api/*`
- Mounts Better Auth handlers at `/api/auth/*`
- Applies CORS, auth middleware, and admin guards

2. Worker (`worker.js`)
- Polls queue for jobs every 2 seconds
- Runs extraction jobs and generation jobs
- Maintains lease heartbeat while running
- Requeues retryable failures and fails non-retryable jobs

3. Database (PostgreSQL)
- Stores users, sessions, documents, excerpts, jobs, generations, limits, usage, and admin/audit data

4. Object storage (R2)
- Stores uploaded files by key
- Falls back to local path when R2 env vars are not configured

## Processing Pipelines

### Extraction pipeline

`Upload -> Job(extract_document) -> Worker -> DocumentExcerpt rows -> Document complete`

- Upload creates a `Document` and `Job` atomically in one transaction
- Worker extracts text from PDF/DOCX/PPTX into `DocumentExcerpt`
- `Document.processingStatus` moves through `queued -> processing -> complete|failed`

### Generation pipeline

`POST /api/document/:id/generations -> Job(generate_*) -> Worker -> DocumentGeneration -> canonical + mirror writes`

- Generation is independent from extraction lifecycle
- Canonical generation state is on `DocumentGeneration`
- Generation options now allow optional `regenerationGuidance` (`reasonKey`, `customInstruction`) in addition to type-specific options
- On completion, flashcard/exam generations dual-write canonical records (`FlashcardSet`/`FlashcardCard`, `ExamRecord`/`ExamQuestion`) and legacy mirrors
- `Document.summary`, `Document.flashcards`, and `Document.examQuestions` remain compatibility mirrors for current frontend behavior (read path unchanged)

## API Surface

### Health

- `GET /api/health`

### Auth (Better Auth)

- `POST /api/auth/sign-up/email`
- `POST /api/auth/sign-in/email`
- `GET /api/auth/get-session`
- `POST /api/auth/sign-out`

### User

- `GET /api/user/me`

### Documents

- `POST /api/upload`
- `GET /api/document/:id`
- `DELETE /api/document/:id`
- `GET /api/document/:id/excerpts`
- `POST /api/document/:id/generations`
- `GET /api/document/:id/generations`

### Learning progress

- `POST /api/flashcard/progress`
- `POST /api/exam/attempt`

### Canonical Phase 2 APIs (additive, no frontend switch yet)

Flashcards:
- `GET /api/document/:id/flashcard-sets`
- `GET /api/flashcard-sets/:setId`
- `PATCH /api/flashcard-sets/:setId/cards/:cardId/state`
- `GET /api/flashcard-sets/:setId/incorrect-session`

Exams:
- `GET /api/document/:id/exams`
- `GET /api/exams/:examId`
- `POST /api/exams/:examId/attempts`
- `GET /api/exams/:examId/attempts/current`
- `POST /api/exam-attempts/:attemptId/save`
- `POST /api/exam-attempts/:attemptId/submit`
- `POST /api/exam-attempts/:attemptId/restart`
- `GET /api/exam-attempts/:attemptId/review`

Exports:
- `POST /api/exports/exams`
- `GET /api/exports`
- `GET /api/exports/:id`
- `GET /api/exports/:id/download`

### Jobs

- `GET /api/jobs/:id`

### Admin

User/session management:
- `GET /api/admin/users`
- `POST /api/admin/users`
- `GET /api/admin/users/:id`
- `PATCH /api/admin/users/:id`
- `DELETE /api/admin/users/:id`
- `POST /api/admin/users/:id/suspend`
- `POST /api/admin/users/:id/unsuspend`
- `GET /api/admin/users/:id/files`
- `DELETE /api/admin/users/:id/files/:documentId`
- `GET /api/admin/users/:id/sessions`
- `DELETE /api/admin/users/:id/sessions`
- `DELETE /api/admin/users/:id/sessions/:sessionId`
- `GET /api/admin/sessions`
- `DELETE /api/admin/sessions/:sessionId`

Monitoring/analytics:
- `GET /api/admin/analytics`
- `GET /api/admin/storage`
- `GET /api/admin/audit-logs`
- `GET /api/admin/usage`
- `GET /api/admin/usage/:userId`
- `GET /api/admin/costs/summary`
- `GET /api/admin/users/:id/limits`
- `PATCH /api/admin/users/:id/limits`
- `GET /api/admin/anomalies`
- `PATCH /api/admin/anomalies/:id/resolve`

Feature flags:
- `GET /api/admin/features`
- `POST /api/admin/features/:key/toggle`
- `POST /api/admin/features/:key/grant`
- `POST /api/admin/features/:key/revoke`
- `GET /api/admin/features/audit`

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
- Worker execution state: `Job.status`, `workerId`, `leaseExpiresAt`, `lastHeartbeatAt`, `retryCount`
- Generation lifecycle/history: `DocumentGeneration.status`, `isLatest`, `output`, `options`, `errorMessage`
- Phase 2 foundations (additive, not yet active in routes): flashcard sets/cards/state, exam records/questions, export artifacts, and expanded `ExamAttempt` fields for in-progress lifecycle
- Phase 2 milestone 2 data migration: `npm run phase2:backfill` backfills canonical flashcards/exams/progress/attempt links from legacy mirrors and runs reconciliation validation
- Phase 2 milestone 3 APIs: canonical study artifacts are readable through additive endpoints while legacy `/api/document/:id` payload remains the frontend contract

## Worker Safety and Recovery

- Uses `SELECT ... FOR UPDATE SKIP LOCKED` to claim queued jobs
- Sends lease heartbeats while work is active
- Sweeps stale jobs on startup and every 15 seconds
- Retries transient failures until `maxRetries`
- Marks non-retryable failures immediately

## Deployment Notes

Production:
- Railway backend: `https://ai-assistant-backend-production-ddf0.up.railway.app`
- Branch: `production`

Staging:
- Railway backend: `https://ai-assistant-backend-staging.up.railway.app`
- Branch: `stage`

Important env vars:
- `DATABASE_URL`
- `OPENAI_API_KEY`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_BASE_URL` (or `BETTER_AUTH_URL`)
- `ADMIN_EMAILS`
- `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`

## Maintenance

Update this file when any of the following changes:
- Route contracts
- Job lifecycle behavior
- Schema models/relationships
- Deployment endpoints or required environment variables

Last Updated: March 10, 2026
