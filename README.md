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

## Related Docs

- `SYSTEM_OVERVIEW.md`: lifecycle, runtime, routes, and architecture
- `PROJECT_STRUCTURE.md`: file and folder ownership
- `agent.md` / `AGENTS.md`: contributor operating instructions

Last Updated: March 23, 2026
