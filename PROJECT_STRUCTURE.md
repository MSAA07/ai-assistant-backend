# Project Structure

This document maps the current backend repository structure and shows how the codebase supports the Study Hub flow.

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

## Top-Level Operational Files

- `server.js`: boots the API, mounts all routers, and normalizes schema-backed document state on startup
- `worker.js`: long-running worker for extraction and generation jobs with leases, retries, and stale-job recovery
- `auth.js`: Better Auth configuration
- `backfill-storage.js`: recomputes `User.storageUsed`
- `reset-db.js`: destructive reset helper for non-production environments

## Documentation Files

- `README.md`: project entry point, current product flow, and setup guide
- `SYSTEM_OVERVIEW.md`: architecture, lifecycle, API map, and deployment notes
- `PROJECT_STRUCTURE.md`: repository layout and responsibility map
- `agent.md`: practical contributor handbook for backend work
- `AGENTS.md`: repository-specific agent instructions
- `DEPLOY_TRIGGER.md`: no-op deployment marker documentation

## Directories

### `routes/`

Routes are grouped by product layer and support flow.

- `documents.js`: upload, document read/delete, excerpts, generation queueing, generation state reads
- `user.js`: authenticated Study Hub Library bootstrap via `GET /api/user/me`
- `jobs.js`: live processing polling for queued/running jobs
- `flashcards.js`: compatibility progress route plus canonical flashcard-set and card-state routes
- `exams.js`: compatibility exam-attempt route plus canonical exam and attempt lifecycle routes
- `exports.js`: exam export creation, listing, lookup, and download routes
- `admin.js`: admin APIs for users, sessions, storage, analytics, usage, costs, anomalies, and feature flags

### `middleware/`

- `auth.js`: Better Auth session guard (`requireAuth`) and admin auto-elevation by configured email
- `adminGuard.js`: admin-only authorization for `/api/admin/*`
- `rateLimit.js`: in-memory request limiter used for generation throttling

### `utils/`

Core lifecycle helpers:
- `documentGeneration.js`: generation types, option validation, state serialization, and helper constants
- `documentStatus.js`: document processing normalization and serialized library/document payloads
- `extractionPipeline.js`: extraction job processor for PDF, DOCX, and PPTX files
- `generationPipeline.js`: generation job processor and usage recording
- `jobQueue.js`: queue claiming, progress updates, completion/failure transitions, requeueing, and stale-job recovery
- `studyMaterials.js`: OpenAI prompt construction, source sampling, and output normalization
- `storage.js`: R2 and local file storage operations

Operational support:
- `auditLog.js`: admin audit helper
- `costGuard.js`: usage recording and anomaly checks
- `featureFlags.js`: feature-flag reads and assignment helpers
- `limits.js`: daily/monthly guardrails
- `sentry.js`: Sentry bootstrap and capture helpers
- `serializers.js`: JSON-safe serializers for BigInt and Decimal values

Canonical artifact and compatibility helpers:
- `phase2Backfill.js`: compatibility migration utilities between document mirrors and canonical study records
- `phase2Flashcards.js`: flashcard set serialization helpers
- `phase2Exams.js`: exam serialization helpers
- `phase2Exports.js`: export artifact serialization helpers
- `phase2GenerationRecords.js`: canonical generation record helpers
- `phase2SourceRefs.js`: source-reference utilities for canonical artifacts

### `prisma/`

- `schema.prisma`: current 23-model PostgreSQL schema
- `seed.js`: default admin seeding
- `migrations/`: Prisma migration history

### `scripts/`

- `extract_pptx.py`: PPTX extraction helper invoked by the backend pipeline
- `backfill-phase2-canonical.js`: compatibility backfill and reconciliation script for canonical flashcard/exam records

## Product Flow Mapping

### Home and upload

Primary files:
- `routes/documents.js`
- `utils/storage.js`
- `utils/extractionPipeline.js`
- `utils/jobQueue.js`

### Processing state

Primary files:
- `routes/jobs.js`
- `utils/documentStatus.js`
- `utils/jobQueue.js`
- `worker.js`

### Study Hub Library

Primary files:
- `routes/user.js`
- `utils/documentStatus.js`

### Study Hub Document

Primary files:
- `routes/documents.js`
- `utils/documentGeneration.js`
- `utils/documentStatus.js`

### Activity Modes

Primary files:
- `routes/flashcards.js`
- `routes/exams.js`
- `routes/exports.js`
- `utils/phase2Flashcards.js`
- `utils/phase2Exams.js`
- `utils/phase2Exports.js`

## Notes

- Runtime uploads are written under `/tmp/uploads` before moving to R2 or using local-path fallback.
- `Document`, `DocumentGeneration`, and `Job` are the core entities behind library cards, document feature cards, and processing states.
- The backend keeps document mirror fields (`summary`, `flashcards`, `examQuestions`) for the current read contract while also maintaining canonical flashcard and exam records.
- Documentation and implementation should describe the simplified Study Hub model consistently.

Last Updated: March 11, 2026

