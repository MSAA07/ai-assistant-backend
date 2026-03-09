# Project Structure

This document maps the current backend repository structure.

## Root Tree

```text
ai-assistant-backend/
|-- AGENTS.md
|-- agent.md
|-- SYSTEM_OVERVIEW.md
|-- PROJECT_STRUCTURE.md
|-- DEPLOY_TRIGGER.md
|-- package.json
|-- package-lock.json
|-- Dockerfile
|-- railway.toml
|-- nixpacks.toml
|-- requirements.txt
|-- server.js
|-- worker.js
|-- auth.js
|-- backfill-storage.js
|-- reset-db.js
|-- middleware/
|-- prisma/
|-- routes/
|-- scripts/
`-- utils/
```

## Directories

### `routes/`

- `documents.js`: upload, document read/delete, excerpts read, generation queue/read
- `jobs.js`: polling endpoint for queue jobs
- `user.js`: authenticated user profile + document list
- `flashcards.js`: flashcard progress tracking
- `exams.js`: exam attempt tracking
- `admin.js`: admin APIs (users, sessions, limits, usage, costs, anomalies, feature flags)

### `middleware/`

- `auth.js`: Better Auth session guard (`requireAuth`)
- `adminGuard.js`: admin role enforcement
- `rateLimit.js`: in-memory request limiter

### `utils/`

- `auditLog.js`: admin audit helper
- `costGuard.js`: usage/cost anomaly checks and recording
- `documentGeneration.js`: generation types, normalization, serialization
- `documentStatus.js`: lifecycle serialization/backfill
- `extractionPipeline.js`: extraction job processor
- `featureFlags.js`: feature-flag toggles and assignments
- `generationPipeline.js`: generation job processor
- `jobQueue.js`: claim/requeue/fail/complete/recover jobs
- `limits.js`: monthly/daily cap helpers
- `sentry.js`: Sentry bootstrap and capture helpers
- `serializers.js`: JSON-safe serializers for BigInt/Decimal
- `storage.js`: R2/local storage operations
- `studyMaterials.js`: OpenAI prompts/output normalization

### `prisma/`

- `schema.prisma`: 17-model PostgreSQL schema
- `seed.js`: default admin seeding
- `migrations/`: migration history

### `scripts/`

- `extract_pptx.py`: PPTX extraction helper called by backend pipeline

## Top-Level Operational Files

- `server.js`: starts API server, mounts all routers, checks schema prerequisites
- `worker.js`: long-running worker loop for extraction/generation jobs
- `auth.js`: Better Auth server configuration
- `backfill-storage.js`: recomputes `User.storageUsed`
- `reset-db.js`: destructive reset helper for non-production environments

## Notes

- Temporary uploads are written under `/tmp/uploads` at runtime.
- Generation-related code lives in `utils/generationPipeline.js`, `utils/documentGeneration.js`, and `utils/studyMaterials.js`.
- Admin API coverage is now broader than early docs and includes usage/cost/feature-flag operations.

Last Updated: March 9, 2026
