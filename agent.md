# Agent Documentation (Backend)

Practical handbook for contributors working in `ai-assistant-backend`.

## Product Terminology

Use the current Study Hub model in code comments and documentation:

- `Home`: entry point before upload
- `Study Hub Library`: grid of uploaded materials
- `Study Hub Document`: document-level feature entry view
- `Activity Modes`: Summary reader, Flashcard study mode, Mock Exam mode

The canonical user flow is:

`Home -> Upload document -> Choose generation options -> Processing state -> Study Hub Library -> Study Hub Document -> Activity Mode`

Keep documentation and review language aligned with the current Study Hub model.

## Stack

- Node.js + Express
- Prisma + PostgreSQL
- Better Auth
- OpenAI (`gpt-4o-mini`) for on-demand generations
- Cloudflare R2 for file storage with local fallback

## Lifecycle Model

Extraction lifecycle lives on `Document`:
- `queued -> processing -> complete | failed`

Worker execution lifecycle lives on `Job`:
- `queued -> running -> succeeded | failed`
- live progress is exposed through `progressPct`

Generation lifecycle/history lives on `DocumentGeneration`:
- `not_requested -> queued -> running -> complete | failed`
- only one latest row per feature (`isLatest = true`)

## Backend Mapping to the Study Hub

### Library layer

- `GET /api/user/me` returns the library shelf data
- document cards are derived from serialized `Document` records
- feature readiness is read from `generationState`

### Document layer

- `GET /api/document/:id` returns the selected document view
- `POST /api/document/:id/generations` queues Summary, Flashcards, or Mock Exam work
- `GET /api/document/:id/generations` returns feature-card state without refetching the whole document

### Activity layer

- Summary reads from the document payload
- Flashcards use the canonical flashcard-set routes plus compatibility progress writes
- Exams use canonical exam/attempt routes plus compatibility attempt writes

## Generation and Regeneration Rules

- Validate `req.body` before queueing generation work
- Extraction must be `complete` before generation can start
- Matching completed generations should be reused when `regenerate` is not set
- Matching queued/running generations should be reused instead of duplicated
- Regeneration guidance is optional and lives under `options.regenerationGuidance`
- Flashcard and exam completions must keep canonical records and document mirror fields in sync

## Key Commands

- `npm start`
- `npm run worker`
- `npm run dev`
- `npm run db:push`
- `npm run db:studio`
- `npm run seed`
- `npm run phase2:backfill`
- `node backfill-storage.js`

## API Reference (Core)

- `GET /api/health`
- `GET /api/user/me`
- `POST /api/upload`
- `GET /api/document/:id`
- `DELETE /api/document/:id`
- `GET /api/document/:id/excerpts`
- `POST /api/document/:id/generations`
- `GET /api/document/:id/generations`
- `GET /api/jobs/:id`
- `POST /api/flashcard/progress`
- `POST /api/exam/attempt`

Canonical study APIs:
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

Auth endpoints are served by Better Auth under `/api/auth/*`.

## Admin Coverage

Admin APIs include:
- users, sessions, and file management
- analytics, storage, and audit logs
- usage events, cost summary, and per-user limits
- anomaly resolution
- feature-flag toggle, grant, revoke, and audit history

## Development Rules

- Keep route handlers defensive: validate input, return JSON errors, and fail early on invalid requests
- Use transactions for coupled state updates
- Keep extraction and generation concerns separated
- Use `serializeDocument` / generation helpers instead of hand-rolling document payloads
- Update docs in the same commit when route contracts, lifecycle behavior, or Study Hub flow assumptions change

## Git and Deploy

- Work on `stage`
- Push `stage` for staging validation
- Push `production` only when explicitly requested

## Required Environment Variables

- `DATABASE_URL`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_BASE_URL` or `BETTER_AUTH_URL`
- `OPENAI_API_KEY`

## Optional Environment Variables

- `ADMIN_EMAILS`
- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`

Last Updated: March 11, 2026

