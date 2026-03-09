# BACKEND SPECIALIST - AI Assistant Backend
Parent Agent: `C:/Users/Saudp/projects/AGENTS.md`
Role: API, Prisma/Postgres, OpenAI generation pipeline, Railway deploys

## 1. Project Overview

Backend API for the AI Study Assistant.

Current pipelines:
- Extraction: `Upload -> Job(extract_document) -> Worker -> DocumentExcerpt -> Document complete`
- Generation: `POST /api/document/:id/generations -> Job(generate_*) -> Worker -> DocumentGeneration -> Document mirror fields`

Current deployment:
- Production: `https://ai-assistant-backend-production-ddf0.up.railway.app`
- Staging: `https://ai-assistant-backend-staging.up.railway.app`

## 2. Commands

Setup and run:
- `npm install`
- `npm start` (runs `prisma db push --accept-data-loss && node server.js`)
- `npm run worker` (runs `prisma db push --accept-data-loss && node worker.js`)
- `npm run dev` (server only)

Database:
- `npm run db:push`
- `npm run db:studio`
- `npx prisma generate`
- `npm run seed`
- `node backfill-storage.js`

## 3. Coding Rules

- Use ES modules only (`import`/`export`)
- Use `async/await` and route-level `try/catch`
- Validate `req.body`, `req.params`, and uploaded files before processing
- Return JSON errors as `{ error: string }`
- Use Prisma for all data access
- Use transactions for multi-step state updates

## 4. Security and Auth Rules

- Never commit `.env` values or secrets
- Require `requireAuth` for non-public routes
- Require admin guard for all `/api/admin/*`
- Enforce ownership checks for user document/job access
- Keep `credentials: include` compatibility for browser clients

## 5. API Snapshot

Public:
- `GET /api/health`

Auth:
- `POST /api/auth/sign-up/email`
- `POST /api/auth/sign-in/email`
- `GET /api/auth/get-session`
- `POST /api/auth/sign-out`

Core:
- `GET /api/user/me`
- `POST /api/upload`
- `GET /api/document/:id`
- `DELETE /api/document/:id`
- `GET /api/document/:id/excerpts`
- `POST /api/document/:id/generations`
- `GET /api/document/:id/generations`
- `POST /api/flashcard/progress`
- `POST /api/exam/attempt`
- `GET /api/jobs/:id`

Admin:
- User/session/file operations
- Usage/cost analytics endpoints
- Per-user limits endpoints
- Cost anomaly endpoints
- Feature-flag management endpoints

## 6. Deployment and Env

Required env vars:
- `DATABASE_URL`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_BASE_URL` (or `BETTER_AUTH_URL`)
- `OPENAI_API_KEY`

Optional env vars:
- `ADMIN_EMAILS`
- R2 vars: `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`

## 7. Git Workflow

Current project workflow:
1. Work on `stage`
2. Commit focused changes
3. Push `stage` to trigger staging deploys
4. Promote to `production` only when explicitly requested

## 8. Documentation Maintenance

Update docs in the same commit when changing:
- API contracts
- Job lifecycle behavior
- Schema models
- Deployment/env requirements

Last Updated: March 9, 2026
