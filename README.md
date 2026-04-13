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
- large documents use a two-step sampled flow with a grounded learning-content analysis pass
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

Optional environment variables:

- `ADMIN_EMAILS`
- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`

## Deployment

- `stage` -> staging Railway deployment
- `production` -> production Railway deployment

Current backend targets:

- Staging: `https://ai-assistant-backend-staging.up.railway.app`
- Production: `https://ai-assistant-backend-production-ddf0.up.railway.app`

Production frontend origins expected by auth/CORS:

- `https://studymaxing.com`
- `https://www.studymaxing.com`

## Related Docs

- `SYSTEM_OVERVIEW.md`: lifecycle, runtime, routes, and architecture
- `PROJECT_STRUCTURE.md`: file and folder ownership
- `agent.md` / `AGENTS.md`: contributor operating instructions
- `PHASE1_PROMPT_ENGINEERING.md`, `PHASE3_MODEL_ROUTING_BENCHMARK.md`, `PHASE4_ROLLOUT_VALIDATION.md`, `PHASE5_FINAL_EXECUTION_BRIEF.md`: archival rollout records, not the live runtime source of truth

Last Updated: March 28, 2026
