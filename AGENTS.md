# BACKEND SPECIALIST - AI Assistant Backend
Parent Agent: `C:/Users/Saudp/projects/AGENTS.md`
Role: API, Prisma/Postgres, OpenAI generation pipeline, Railway deploys

## 1. Project Overview

Backend API for the AI Study Assistant Study Hub.

Current product layers:
- Study Hub Library: uploaded document shelf
- Study Hub Document: feature-entry cards for Summary, Flashcards, and Mock Exam
- Activity Modes: summary reader, flashcard study mode, exam mode

Canonical user flow:
- `Home -> Upload document -> Choose generation options -> Processing state -> Study Hub Library -> Study Hub Document -> Activity Mode`

Core backend pipelines:
- Extraction: `Upload -> Job(extract_document) -> Worker -> DocumentExcerpt -> Document complete`
- Generation: `POST /api/document/:id/generations -> Job(generate_*) -> Worker -> DocumentGeneration -> canonical study records + document mirrors`

Current deployment:
- Production: `https://ai-assistant-backend-production-ddf0.up.railway.app`
- Staging: `https://ai-assistant-backend-staging.up.railway.app`

## 2. Commands

Setup and run:
- `npm install`
- `npm start` (runs `prisma db push --accept-data-loss && node server.js`)
- `npm run worker` (runs `prisma db push --accept-data-loss && node worker.js`)
- `npm run dev` (server only)

Database and maintenance:
- `npm run db:push`
- `npm run db:studio`
- `npx prisma generate`
- `npm run seed`
- `npm run phase2:backfill`
- `node backfill-storage.js`

## 3. Coding Rules

- Use ES modules only (`import` / `export`)
- Use `async/await` and route-level `try/catch`
- Validate `req.body`, `req.params`, and uploaded files before processing
- Return JSON errors as `{ error: string }`
- Use Prisma for all data access
- Use transactions for multi-step state updates
- Keep document serialization aligned with the Study Hub Library / Document / Activity split

## 4. Security and Auth Rules

- Never commit `.env` values or secrets
- Require `requireAuth` for non-public routes
- Require admin guard for all `/api/admin/*`
- Enforce ownership checks for user document, job, flashcard, exam, and export access
- Keep `credentials: include` compatibility for browser clients

## 5. API Snapshot

Public:
- `GET /api/health`

Auth:
- `POST /api/auth/sign-up/email`
- `POST /api/auth/sign-in/email`
- `GET /api/auth/get-session`
- `POST /api/auth/sign-out`

Library and document flow:
- `GET /api/user/me`
- `POST /api/upload`
- `GET /api/document/:id`
- `DELETE /api/document/:id`
- `GET /api/document/:id/excerpts`
- `POST /api/document/:id/generations`
- `GET /api/document/:id/generations`
- `GET /api/jobs/:id`

Activity routes:
- `POST /api/flashcard/progress`
- `POST /api/exam/attempt`
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

Admin:
- User/session/file operations
- Usage/cost analytics endpoints
- Per-user limits endpoints
- Cost anomaly endpoints
- Feature-flag management endpoints

## 6. Generation and Processing Expectations

- Extraction state lives on `Document.processingStatus`
- Live worker status lives on `Job.status` and `progressPct`
- Generation state lives on `DocumentGeneration`
- `GET /api/document/:id` and `GET /api/document/:id/generations` must stay aligned with the Study Hub feature cards
- Regeneration supports optional guided prompts through `options.regenerationGuidance`
- Flashcard and exam generations must keep canonical records and document mirror fields consistent

## 7. Deployment and Env

Required env vars:
- `DATABASE_URL`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_BASE_URL` (or `BETTER_AUTH_URL`)
- `OPENAI_API_KEY`

Optional env vars:
- `ADMIN_EMAILS`
- R2 vars: `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`

## 8. Git Workflow

Current project workflow:
1. Work on `stage`
2. Commit focused changes
3. Push `stage` to trigger staging deploys
4. Promote to `production` only when explicitly requested

## 9. Documentation Maintenance

Update docs in the same commit when changing:
- API contracts
- job lifecycle behavior
- schema models
- deployment/env requirements
- Study Hub Library / Document / Activity flow assumptions

Keep docs, issues, and review notes aligned with current Study Hub terminology and flow.

Last Updated: March 11, 2026

