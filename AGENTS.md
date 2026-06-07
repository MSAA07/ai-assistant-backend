# BACKEND SPECIALIST - AI Assistant Backend

Role: Express API, Prisma/PostgreSQL, worker lifecycle, OpenAI generation pipeline, Railway deployment.

## Scope

This file is for backend operating instructions, not the full system reference.

Use these source-of-truth docs instead:

- `SYSTEM_OVERVIEW.md` for lifecycle ownership, runtime behavior, and route contracts
- `PROJECT_STRUCTURE.md` for file ownership
- root `PHASE*.md` files are archival rollout records, not the live runtime source of truth

## Commands

- `npm install`
- `npm start`
- `npm run worker`
- `npm run dev`
- `npm run db:push`
- `npm run db:studio`
- `npm run seed`
- `npm run phase2:backfill`
- `npm run auth:check-config`
- `npm run telegram:setup-webhook`
- `npm run telegram:test-alert`

## Documentation Triggers

Update docs when:

- runtime truth changes: `SYSTEM_OVERVIEW.md`
- structure changes: `PROJECT_STRUCTURE.md`
- onboarding/setup changes: `README.md`
- admin QA tiers, cooldowns, scheduler, or persisted QA history changes: `SYSTEM_OVERVIEW.md`, `PROJECT_STRUCTURE.md`, and `README.md`
- agent workflow changes: `AGENTS.md` / `agent.md`

Last Updated: June 7, 2026
