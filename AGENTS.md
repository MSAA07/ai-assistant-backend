> [!WARNING]
> # PRODUCTION IS OFF LIMITS BY DEFAULT
>
> This project's staging and production environments are distinguished purely by Railway service naming: `studymaxing-backend-staging` and `studymaxing-worker-staging` are staging; `studymaxing-production` and `studymaxing-worker-production` are production. This is **not** Railway's “Environments” feature—do not rely on that UI concept when determining which service you are touching.
>
> Unless a task's instructions explicitly contain the exact phrase **"production readiness"**, never deploy to, run migrations against, run scripts against, or otherwise write to any production-named service or its database. Never select or default to a production URL or target in any admin, QA, or configuration UI you build or modify. Do not read secrets or environment variables scoped to a production service unless explicitly told to.
>
> If a task is ambiguous about which environment it targets, stop and ask rather than guessing. Do not assume staging is safe to extrapolate to production, and do not infer that the user probably means production from context alone.
>
> This rule applies to every task in this repo, regardless of other task instructions, unless the task instructions contain **"production readiness"**.

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

## UI Quality Rules (do not skip)

- Any `<select>`/`<option>` element must have explicit background-color and color set from design tokens — never rely on browser defaults for dark theme. Test in both Chrome and Safari before claiming done.
- A UI fix is not "verified" until tested with real interaction (manual click or Playwright selectOption on native elements — not raw dispatched input/change events, which are unreliable on custom-bound components).
- Before reporting any UI fix as complete, provide a screenshot AND confirm the deployed bundle hash changed (rule out stale cache as a false negative).
- Do not report a fix as "done" or "verified" unless it was actually confirmed working end-to-end, including checking that state changes actually persist after a page reload.

Last Updated: June 7, 2026
