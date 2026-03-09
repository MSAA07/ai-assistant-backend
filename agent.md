# Agent Documentation (Backend)

This file is a practical handbook for contributors working in `ai-assistant-backend`.

## Stack

- Node.js + Express
- Prisma + PostgreSQL
- Better Auth
- OpenAI (`gpt-4o-mini`) for on-demand generations
- Cloudflare R2 for file storage

## Lifecycle Model

Extraction lifecycle lives on `Document`:
- `queued -> processing -> complete | failed`

Worker execution lifecycle lives on `Job`:
- `queued -> running -> succeeded | failed`

Generation lifecycle/history lives on `DocumentGeneration`:
- `queued -> running -> complete | failed`
- only one latest row per feature (`isLatest = true`)

## Key Commands

- `npm start`
- `npm run worker`
- `npm run dev`
- `npm run db:push`
- `npm run db:studio`
- `npm run seed`
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

Auth endpoints are served by Better Auth under `/api/auth/*`.

## Admin Coverage

Admin APIs include:
- users, sessions, file management
- analytics, storage, audit logs
- usage events, cost summary, per-user limits
- anomaly resolution
- feature-flag toggle/grant/revoke/audit

## Development Rules

- Keep route handlers defensive: validate input, return early on invalid requests
- Use transactions for coupled updates (document/job or document/user counters)
- Keep extraction and generation concerns separated
- Do not change schema without updating docs and running Prisma generation

## Git and Deploy

- Push to `stage` for staging validation
- Push to `production` only when explicitly requested

## Required Environment Variables

- `DATABASE_URL`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_BASE_URL` (or `BETTER_AUTH_URL`)
- `OPENAI_API_KEY`

## Optional Environment Variables

- `ADMIN_EMAILS`
- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`

Last Updated: March 9, 2026
