# AI Assistant Backend

Backend API and worker stack for the AI Study Assistant.

## What This Repo Owns

- Express API runtime
- Better Auth server integration
- Prisma/PostgreSQL persistence
- worker-driven extraction and generation
- canonical study records and compatibility mirrors
- Railway deployment configuration

## Quick Orientation

- extraction and generation are both implemented
- document lifecycle, job lifecycle, and generation lifecycle are distinct
- canonical study records are Prisma-backed
- mirror fields remain in document payloads for compatibility
- the AI prompt-engineering rollout is complete in the current generation path
- one shared prompt framework now drives summary, flashcards, and mock exam generation
- default generation keeps the shared prompt path for summary, flashcards, and mock exams
- `GENERATION_PIPELINE_V2` enables the summary study-guide pipeline: extract signals, analyze a global chapter map, synthesize once, optimize for exams, and enforce format
- prompt versions, routing metadata, rollout metadata, and benchmark linkage are persisted in existing internal metadata surfaces
- free, pro, and premium generation behavior is policy-based inside the same backend path
- server entry is `server.js`
- worker entry is `worker.js`

## Local Development

```bash
npm install
npm start
npm run worker
npm run dev
npm run db:push
npm run db:studio
npm run seed
npm run phase2:backfill
```

Required environment variables:

- `DATABASE_URL`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_BASE_URL` or `BETTER_AUTH_URL`
- `OPENAI_API_KEY`
- `RESEND_API_KEY`
- `AUTH_EMAIL_FROM_EMAIL`

Optional environment variables:

- `AUTH_EMAIL_PROVIDER` (`resend` default)
- `AUTH_EMAIL_FROM_NAME` (`Studymaxing` default)
- `AUTH_EMAIL_REPLY_TO`
- `AUTH_EMAIL_SUPPORT_EMAIL`
- `AUTH_EMAIL_APP_URL`
- password-reset callback URLs are frontend-owned via `redirectTo` from the client and should target the deployed frontend root bridge, for example `https://studymaxing.com/?auth_action=reset-password`
- `ADMIN_EMAILS`
- `FRONTEND_ORIGINS` (comma-separated extra allowed frontend origins when needed)
- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`

## Deployment

- `stage` -> staging Railway deployment
- `production` -> production Railway deployment
- `npm start` / `npm run worker` now use:
  - `prisma db push` in non-production
  - `prisma migrate deploy` in production
- production no longer uses `prisma db push --accept-data-loss`

Current backend targets:

- Staging: `https://ai-assistant-backend-staging.up.railway.app`
- Production: `https://ai-assistant-backend-production-ddf0.up.railway.app`

Production frontend origins expected by auth/CORS:

- `https://studymaxing.com`
- `https://www.studymaxing.com`
- `https://my-ai-assistant.vercel.app`
- current `my-ai-assistant*.vercel.app` preview hosts

## Related Docs

- `SYSTEM_OVERVIEW.md`: lifecycle, runtime, routes, and architecture
- `PROJECT_STRUCTURE.md`: file and folder ownership
- `agent.md` / `AGENTS.md`: contributor operating instructions
- `PHASE1_PROMPT_ENGINEERING.md`, `PHASE3_MODEL_ROUTING_BENCHMARK.md`, `PHASE4_ROLLOUT_VALIDATION.md`, `PHASE5_FINAL_EXECUTION_BRIEF.md`: archival rollout records, not the live runtime source of truth

## Auth Config Check

Use this lightweight check before staging or production validation:

```bash
npm run auth:check-config
```

It prints the resolved Better Auth base URL plus the frontend origins allowed by both Better Auth and Express CORS.

Last Updated: March 28, 2026
