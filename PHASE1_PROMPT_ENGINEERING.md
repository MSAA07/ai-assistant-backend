# Phase 1 Prompt Engineering

Archived rollout record.

This file preserves the phase-specific prompt-engineering target for the first rollout step. It is not the live backend source of truth after the completed rollout and correction passes.

Current runtime truth now lives in:

- `SYSTEM_OVERVIEW.md`
- `PROJECT_STRUCTURE.md`
- `README.md`

## Scope
- Applies to backend generation for `summary`, `flashcards`, and `exam`.
- Does not change lifecycle ownership, Prisma schema, public API contracts, model routing, or pricing-tier behavior.

## Implemented prompt stack
- Shared base system prompt:
  - grounding rules
  - no outside knowledge
  - no invented facts or fake references
  - source-language matching
  - weak-material degradation
  - duplication control
- Feature prompt:
  - summary: deep study-ready summary
  - flashcards: balanced, quality-first cards with count scaling
  - exam: quality-first MCQ/true-false output with grounded explanations
- Large-document analysis prompt:
  - runs only when source material must be sampled to fit the single-pass window
  - produces a filtered learning-content map
- Final generation prompt:
  - consumes either raw excerpts or the learning-content map
  - returns the same JSON shapes expected by the current pipeline

## Prompt versions
- `sharedBasePromptVersion`: `1.0.0`
- `summaryPromptVersion`: `1.0.0`
- `flashcardsPromptVersion`: `1.0.0`
- `mockExamPromptVersion`: `1.0.0`
- `largeDocumentAnalysisPromptVersion`: `1.0.0`

## Contract notes
- Summary remains text-first.
- Flashcards and exams remain normalized into existing contracts.
- No new persisted prompt-version metadata is written in Phase 1.
- No legacy compatibility routes were changed.
