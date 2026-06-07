# Agent Documentation (Backend)

Contributor guide for `ai-assistant-backend`.

## Scope

This file is for backend contributor behavior only.

For lifecycle ownership, route contracts, and runtime architecture:

- see `SYSTEM_OVERVIEW.md`

For file ownership:

- see `PROJECT_STRUCTURE.md`

For rollout history:

- root `PHASE*.md` files are archival records, not the live runtime source of truth

## Development Rules

- Validate input before queueing or mutating state.
- Keep lifecycle ownership explicit in code and docs.
- Use transactions for coupled updates.
- Use serializer helpers instead of hand-rolling document/generation responses.
- Keep admin QA tier behavior, persisted QA history, and scheduler behavior documented when changed.
- Update docs when route contracts, Prisma ownership, or lifecycle behavior changes.

## Commands

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

## Environment

Required:

- `DATABASE_URL`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_BASE_URL` or `BETTER_AUTH_URL`
- `OPENAI_API_KEY`

Optional:

- `ADMIN_EMAILS`
- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `MISTRAL_API_KEY` (Mistral OCR fallback - must be set on both backend and worker Railway services)
- `RESEND_API_KEY`
- `QA_STAGING_API_BASE_URL`
- `QA_PRODUCTION_API_BASE_URL`

## Documentation Triggers

- runtime or lifecycle truth: update `SYSTEM_OVERVIEW.md`
- file ownership: update `PROJECT_STRUCTURE.md`
- onboarding/setup: update `README.md`
- admin QA tiers, cooldowns, scheduler, or persisted QA history: update `SYSTEM_OVERVIEW.md`, `PROJECT_STRUCTURE.md`, and `README.md`
- agent workflow rules: update `agent.md` / `AGENTS.md`

Last Updated: June 7, 2026
