# Project Structure (Backend)

This file maps the current backend repository structure.

## Root Tree

```text
ai-assistant-backend/
|-- AGENTS.md
|-- agent.md
|-- README.md
|-- SYSTEM_OVERVIEW.md
|-- PROJECT_STRUCTURE.md
|-- DEPLOY_TRIGGER.md
|-- package.json
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

## Top-Level Responsibilities

- `server.js`: API entry point and startup reconciliation
- `worker.js`: extraction/generation worker, retries, heartbeats, stale-job recovery
- `auth.js`: Better Auth configuration
- `backfill-storage.js`: recompute `User.storageUsed`
- `reset-db.js`: destructive non-production reset helper

## Routes

- `routes/user.js`: Study Hub Library bootstrap
- `routes/documents.js`: upload, read, rename, delete, excerpts, generation queueing
- `routes/jobs.js`: job execution lifecycle polling used by the guided upload flow and study surfaces
- `routes/flashcards.js`: legacy flashcard progress plus canonical flashcard-set routes
- `routes/exams.js`: legacy exam attempt plus canonical exam and attempt routes
- `routes/exports.js`: export artifact routes
- `routes/admin.js`: admin APIs for users, files, sessions, analytics, usage, costs, limits, anomalies, and feature flags

## Middleware

- `middleware/auth.js`: `requireAuth`
- `middleware/adminGuard.js`: `requireAdmin`
- `middleware/rateLimit.js`: generation throttling and shared in-memory rate limiting
- `middleware/featureFlag.js`: feature-flag request helpers

## Core Utilities

Lifecycle and serialization:

- `utils/documentStatus.js`
- `utils/documentGeneration.js`
- `utils/jobQueue.js`

Worker processors:

- `utils/extractionPipeline.js`
- `utils/generationPipeline.js`
- `utils/studyMaterials.js`

Canonical study-record support:

- `utils/phase2Backfill.js`
- `utils/phase2Flashcards.js`
- `utils/phase2Exams.js`
- `utils/phase2Exports.js`
- `utils/phase2GenerationRecords.js`
- `utils/phase2SourceRefs.js`

Operational support:

- `utils/storage.js`
- `utils/limits.js`
- `utils/featureFlags.js`
- `utils/costGuard.js`
- `utils/auditLog.js`
- `utils/sentry.js`
- `utils/serializers.js`

## Prisma Layer

- `prisma/schema.prisma`: current schema
- `prisma/seed.js`: seed entry
- `prisma/migrations/`: migration history

Current migration folders:

- `20260216073943_init`
- `20260302194206_add_jobs_flags_limits_usage_excerpts`
- `20260308000000_document_processing_lifecycle_stabilization`
- `20260309000000_generation_architecture_f2`
- `20260310010000_phase2_foundations_m1`

## Scripts

- `scripts/extract_pptx.py`: PPTX extraction helper
- `scripts/backfill-phase2-canonical.js`: legacy-to-canonical backfill and reconciliation

## Structure Notes

- `Document`, `DocumentGeneration`, and `Job` are distinct ownership layers and should be documented separately.
- Canonical flashcard and exam records are Prisma-backed and coexist with document mirror fields.
- `POST /api/upload` and worker processing still use `/tmp/uploads` during local/temp file handling before R2 or local-path persistence is finalized.
- `utils/extractionPipeline.js` sanitizes extracted excerpt content before `DocumentExcerpt` persistence so invalid UTF-8 control bytes do not reach PostgreSQL.

Last Updated: March 27, 2026
