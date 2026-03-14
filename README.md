# AI Assistant Backend

Backend API and worker stack for the AI Study Assistant.

This repository owns document ingestion, extraction, Study Hub generation jobs, authenticated study activity APIs, admin tooling, and Railway deployment for the backend.

## Current Product Flow

The implemented Study Hub flow is:

`Home -> Upload document -> Choose generation options -> Processing state -> Study Hub Library -> Study Hub Document -> Activity Mode`

Backend responsibilities at each step:

- `Home / Upload`: `POST /api/upload` accepts PDF, DOCX, and PPTX files, creates the `Document`, and queues extraction.
- `Choose generation options`: `POST /api/document/:id/generations` queues `summary`, `flashcards`, or `exam` generation with validated feature-specific options.
- `Processing state`: `GET /api/jobs/:id`, `GET /api/document/:id`, and `GET /api/document/:id/generations` expose upload, extraction, and generation progress/status for live UI polling.
- `Study Hub Library`: `GET /api/user/me` returns the authenticated user profile plus uploaded documents ordered by `uploadDate`, including `processingStatus` and per-feature `generationState` for minimal library cards.
- `Study Hub Document`: `GET /api/document/:id` returns the selected document with the current state for Summary, Flashcards, and Mock Exam entry cards.
- `Activity Modes`: summary content is exposed from the document payload; canonical flashcard and exam routes expose the current study artifacts and attempt state.

## Study Hub Architecture

The backend now maps to three frontend layers:

### 1. Study Hub Library

Document shelf for all uploaded materials.

- Source: `GET /api/user/me`
- Carries document identity, upload metadata, extraction status, and `generationState`
- Supports rename through `PATCH /api/document/:id`
- Supports deletion through `DELETE /api/document/:id`
- Uses uploaded names from `originalName`

### 2. Study Hub Document

Feature-entry view for a single document.

- Source: `GET /api/document/:id`
- Exposes three feature states: `summary`, `flashcards`, `exam`
- Each feature card is driven by the latest `DocumentGeneration` row for that type
- Navigation is intentionally simplified around back navigation and feature entry.

### 3. Activity Modes

Study surfaces for generated content.

- Summary reader: document summary text
- Flashcard study mode: canonical `FlashcardSet`, `FlashcardCard`, and `FlashcardCardState` APIs
- Mock exam mode: canonical `ExamRecord`, `ExamQuestion`, and `ExamAttempt` APIs

## Processing and Generation Model

### Extraction

`Upload -> Job(extract_document) -> Worker -> DocumentExcerpt rows -> Document complete`

- `Document.processingStatus`: `queued -> processing -> complete | failed`
- `Job.status`: `queued -> running -> succeeded | failed`
- The worker updates `Job.progressPct` so the frontend can show live extraction progress
- Content is hidden from document reads until extraction reaches `complete`

### Generation

`POST /api/document/:id/generations -> Job(generate_*) -> Worker -> DocumentGeneration -> canonical records + document mirrors`

- Canonical generation state lives on `DocumentGeneration`
- `generationState` on document payloads is derived from the latest generation row per feature
- Requests can reuse an existing completed generation when options match
- Requests can reuse an active queued/running generation when the same options are already in flight
- Regeneration is explicit through `regenerate: true`
- Optional guided prompts are supported through `options.regenerationGuidance.reasonKey` and `options.regenerationGuidance.customInstruction`
- Flashcard and exam completions also upsert canonical study records while maintaining document mirror fields for the current read contract

## Core API Surface

### Public

- `GET /api/health`

### Auth

Better Auth is mounted at `/api/auth/*`.

- `POST /api/auth/sign-up/email`
- `POST /api/auth/sign-in/email`
- `GET /api/auth/get-session`
- `POST /api/auth/sign-out`

### Library and document flow

- `GET /api/user/me`
- `POST /api/upload`
- `GET /api/document/:id`
- `PATCH /api/document/:id`
- `DELETE /api/document/:id`
- `GET /api/document/:id/excerpts`
- `POST /api/document/:id/generations`
- `GET /api/document/:id/generations`
- `GET /api/jobs/:id`

### Activity-mode APIs

Compatibility routes still used by the current frontend:

- `POST /api/flashcard/progress`
- `POST /api/exam/attempt`

Canonical study routes exposed by the backend:

- `GET /api/document/:id/flashcard-sets`
- `GET /api/flashcard-sets/:setId`
- `PATCH /api/flashcard-sets/:setId/cards/:cardId/state`
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

### Admin

Admin endpoints cover users, sessions, storage, analytics, usage/cost controls, anomalies, and feature flags under `/api/admin/*`.

## Local Development

### Commands

- `npm install`
- `npm start`
- `npm run worker`
- `npm run dev`
- `npm run db:push`
- `npm run db:studio`
- `npm run seed`
- `npm run phase2:backfill`
- `node backfill-storage.js`

### Required environment variables

- `DATABASE_URL`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_BASE_URL` or `BETTER_AUTH_URL`
- `OPENAI_API_KEY`

### Optional environment variables

- `ADMIN_EMAILS`
- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`

## Deployment

- `stage` branch -> staging Railway deployment
- `production` branch -> production Railway deployment

Current deployments:

- Staging: `https://ai-assistant-backend-staging.up.railway.app`
- Production: `https://ai-assistant-backend-production-ddf0.up.railway.app`

## Documentation Index

- `README.md`: quick project guide
- `SYSTEM_OVERVIEW.md`: architecture, flow, lifecycle, and API map
- `PROJECT_STRUCTURE.md`: repository layout and file responsibilities
- `agent.md`: contributor handbook for backend work
- `AGENTS.md`: repository-specific agent instructions

Last Updated: March 11, 2026
