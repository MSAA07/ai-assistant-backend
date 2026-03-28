# Phase 4 Rollout And Validation

Archived rollout record.

This file preserves the rollout-validation plan used during implementation. It is not the live backend source of truth after the completed rollout and correction passes.

Current runtime truth now lives in:

- `SYSTEM_OVERVIEW.md`
- `PROJECT_STRUCTURE.md`
- `README.md`

## Objective

Introduce the prompt-layer improvements and model-routing policy safely without changing current lifecycle ownership or fragmenting the generation architecture. Preserve current API contracts unless an explicit implementation later requires a contract change. Keep `Document.processingStatus`, `Job.status` with `progressPct`, and `DocumentGeneration` as the lifecycle owners. Keep canonical flashcard and exam record behavior intact. If any persisted contract or Prisma model changes are introduced later, they must be called out as migrations before release.

## Rollout sequence

1. Prompt-layer rollout first.
   - Validate prompt-only behavior first with the existing generation path and existing routing behavior.
   - Keep summary, flashcards, and exam contracts unchanged during this step.
   - Confirm regeneration using `options.regenerationGuidance` still behaves as grounded refinement only.
2. Model-routing rollout second.
   - Enable routing policy only after prompt-layer validation passes.
   - Upgrade mock exam routing first.
   - Keep summary and flashcards on lower-cost-first routing unless benchmark evidence supports broader stronger-model use.
3. Controlled rollout recommendation.
   - Internal testing first.
   - Benchmark validation second.
   - Limited production exposure third.
4. Limited production exposure.
   - Start with internal or tightly controlled cohorts.
   - Expand only after benchmark and regression gates pass.
   - Roll back immediately if grounding, contract correctness, or cost control regresses.
5. Legacy compatibility routes.
   - Do not change legacy compatibility routes unless rollout work directly affects them.
   - If they are affected, validate them against the same contract and regression checks.

## Validation checklist

### Mock exam

- Questions remain fully grounded in uploaded material only.
- Stronger-model routing improves question quality where promised.
- MCQ and true/false output stays contract-valid.
- `DocumentGeneration`, mirror fields, and canonical exam records remain consistent.
- Regeneration with `options.regenerationGuidance` refines output without breaking grounding.
- Fallback from stronger model to lower-cost model preserves contract shape and lifecycle behavior.

### Summary

- Output remains text-first and contract-compatible.
- Language matches the document language.
- No fabricated facts, references, sections, or page labels.
- Weak or thin documents produce narrower summaries instead of invented detail.
- Regeneration guidance changes emphasis only within grounded content.

### Flashcards

- Cards remain grounded, useful, and non-duplicative.
- Canonical flashcard records remain correct.
- Weak documents reduce card count instead of padding weak cards.
- Language matches the source.
- Regeneration guidance improves coverage or usefulness without changing the output contract.

### Shared lifecycle and persistence

- `Document.processingStatus` ownership is unchanged.
- `Job.status` and `progressPct` still represent execution lifecycle only.
- `DocumentGeneration` remains the owner of generation lifecycle state.
- Reuse, retry, regenerate, and fallback flows remain consistent.
- No API contract drift is introduced.
- Any persisted metadata change or Prisma model change is documented with migration impact before rollout.

## Benchmark process

- Use the same fixed 10 benchmark documents for every comparison.
- Run prompt-layer validation first on the 10 documents with routing held constant.
- Run model-routing validation second on the same 10 documents.
- Evaluate the required feature and tier matrix:
  - summary
  - flashcards
  - exam
  - free, pro, premium where applicable
  - quality modes where applicable
  - stronger-model fallback path where applicable
- Record for every run:
  - benchmark document id
  - feature
  - requested options
  - prompt version
  - model policy version
  - selected model
  - actual model used
  - fallback used and fallback reason
  - input tokens
  - output tokens
  - estimated cost
  - evaluator result
- Compare every candidate against the current approved baseline on the same 10 documents.
- Approve prompt changes first, then routing changes second. Do not collapse both into one approval decision.

## Regression gates

- Required regression checks:
  - grounding
  - references
  - language matching
  - duplicate control
  - weak-document handling
- A new prompt version can ship only if:
  - contracts remain unchanged
  - the same 10-document benchmark set passes
  - grounding does not regress
  - weak-document handling does not worsen
  - duplicate rate does not increase materially
  - language matching remains correct
  - mock exam quality is maintained or improved where promised
  - cost growth remains controlled for the rollout stage
- A new prompt version must be rejected if:
  - grounding degrades
  - references become less reliable
  - language mismatch increases
  - duplicate or repetitive output increases materially
  - weak-document behavior becomes more hallucination-prone
  - canonical flashcard or exam persistence regresses
  - lifecycle ownership becomes blurred
  - routing behavior fragments the architecture or changes tier behavior into separate API systems

## Rollback rules

- If a new prompt version lowers quality, revert to the last approved prompt version without changing lifecycle ownership or public contracts.
- If model routing lowers quality or cost control fails, revert to the last approved model policy version while keeping the approved prompt layer intact.
- Rollback must preserve:
  - current API contracts
  - current generation path
  - current lifecycle ownership
  - canonical flashcard and exam persistence
- Preferred rollback method:
  - prompt-layer rollback by prompt-version selection
  - routing rollback by model-policy-version selection
- If a persisted schema or Prisma change is introduced later, rollback must include explicit migration handling before production release.
- If limited production exposure shows regression, stop expansion and return the affected cohort to the last approved prompt and routing combination.

## Traceability requirements

- Every evaluated or released generation path must be traceable by:
  - prompt version
  - model policy version
  - selected model
  - actual model used
  - evaluation result
- Evaluation records must link benchmark outcomes to the exact prompt version and model policy version used.
- Production logging must retain enough metadata to determine:
  - which prompt version produced the output
  - which routing policy selected the model
  - whether fallback occurred
  - which quality mode was applied
- If persisted metadata is added later to support traceability, document whether it changes stored contracts or Prisma models and require a migration callout before rollout.

## Final acceptance criteria

- Prompt-layer rollout is validated first and approved independently.
- Model-routing rollout is validated second and approved independently.
- Internal testing, benchmark validation, and limited production exposure complete in that order.
- All decisions are evaluated on the same 10 benchmark documents.
- Grounding, references, language matching, duplicate control, and weak-document handling pass regression gates.
- Mock exam quality improves where promised, and summary and flashcards do not regress.
- Current API contracts remain unchanged unless an explicitly approved change is required.
- `Document.processingStatus`, `Job.status` with `progressPct`, and `DocumentGeneration` retain current ownership boundaries.
- Canonical flashcard and exam record behavior remains correct.
- `options.regenerationGuidance` remains compatible and grounded.
- Prompt version, model policy version, and evaluation results are traceable for every approved rollout candidate.
- Any persisted contract or Prisma change is explicitly identified with migration impact before release.
