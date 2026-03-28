# Phase 5 Final Execution Brief

Archived rollout record.

This file preserves the execution brief that drove the implementation rollout. It is not the live backend source of truth after the completed rollout and correction passes.

Current runtime truth now lives in:

- `SYSTEM_OVERVIEW.md`
- `PROJECT_STRUCTURE.md`
- `README.md`

## Objective

Implement the final AI prompt-engineering and routing rollout for study generation end to end within the existing backend architecture. Preserve current API contracts unless a change is clearly required. Preserve lifecycle ownership: `Document.processingStatus` for document processing, `Job.status` with `progressPct` for execution lifecycle, and `DocumentGeneration` for generation lifecycle. Preserve canonical flashcard and exam records. Keep regeneration compatible with `options.regenerationGuidance`. Call out any persisted contract or Prisma model change as a migration before release. Mention legacy compatibility routes only if they are touched.

## Locked decisions

- Accuracy first.
- Priority order:
  1. mock exam
  2. summary
  3. flashcards
- Use only uploaded material.
- Do not use outside knowledge.
- Include source references when reliable.
- Use section labels when page certainty is weak.
- Output must match the source document language.
- Summary must be a deep full study summary.
- Summary must remove noise and keep what matters most.
- Summary organization must adapt automatically to the material.
- Flashcards must scale with document length.
- Flashcards must use a balanced mix of definitions, concepts, comparisons, and processes.
- Mock exam must use multiple choice and true/false only.
- Mock exam must scale with document length.
- Long-document behavior must balance quality and coverage.
- Examples are allowed only as reformulations, never as new facts.
- Thin documents should generate only what the source supports.
- Exam explanations should be brief by default, with slightly more teaching only when needed.
- Benchmark validation must use the same 10 real documents for every approval decision.

## Implementation tasks by order

1. Confirm and preserve architecture boundaries.
   - Keep one generation path: request route -> generation queue -> worker -> generation pipeline -> AI gateway.
   - Keep one AI integration and one prompt framework.
   - Keep current lifecycle ownership unchanged.
   - Keep canonical flashcard and exam record writes unchanged.
2. Finalize prompt-layer behavior.
   - Ensure shared base prompt enforces uploaded-material-only behavior, no outside knowledge, grounded references, language matching, weak-document narrowing, and duplication control.
   - Ensure summary prompt implements deep full-study-summary behavior, noise removal, and adaptive organization.
   - Ensure flashcards prompt implements document-length scaling and balanced coverage across definitions, concepts, comparisons, and processes.
   - Ensure mock exam prompt implements MCQ and true/false only, document-length scaling, and brief explanations by default.
   - Keep examples limited to grounded reformulations only.
3. Finalize long-document and thin-document behavior.
   - Keep long-document handling focused on quality and coverage balance.
   - Use sampling and learning-map behavior only within the existing shared prompt system.
   - Ensure thin documents reduce scope or count instead of inventing detail.
4. Finalize model-routing policy.
   - Keep routing as policy inside the existing generation pipeline.
   - Preserve one backend AI gateway and one API surface.
   - Resolve model per request using feature, tier, and optional quality mode.
   - Keep mock exam as the first stronger-model upgrade.
   - Keep summary and flashcards lower-cost-first unless benchmark results justify expansion.
5. Finalize tier behavior.
   - Keep free/pro/premium as routing-policy differences only, not separate architectures.
   - Enforce allowed model, token budget, regeneration allowance, and quality-mode access by policy.
   - Keep prompt framework and feature contracts shared across tiers.
6. Preserve request and persistence compatibility.
   - Keep current API contracts unless a change is clearly necessary.
   - Keep regeneration compatible with `options.regenerationGuidance`.
   - If hidden policy metadata is used internally, do not expose it as a public contract change unless explicitly approved.
   - If persisted metadata or Prisma models must change, document the migration and rollout impact before shipping.
7. Validate canonical and lifecycle behavior.
   - Confirm summary mirror behavior still works.
   - Confirm flashcard canonical records remain correct.
   - Confirm exam canonical records remain correct.
   - Confirm `DocumentGeneration` latest/reuse/regenerate behavior remains correct.
   - Check legacy compatibility routes only if any related code path is changed.
8. Finalize fallback handling.
   - If stronger model is unavailable or budget-limited, downgrade only within the approved routing matrix.
   - Preserve feature contract, lifecycle ownership, and shared architecture during fallback.
   - Log selected model, actual model used, quality mode, and fallback reason for traceability.
9. Complete benchmark and rollout readiness.
   - Run the fixed 10-document benchmark set.
   - Validate prompt-layer changes first.
   - Validate model-routing changes second.
   - Approve limited production exposure only after benchmark and regression gates pass.
10. Update implementation docs.
   - Keep architecture, benchmark, and rollout docs aligned with the final implementation.
   - Document any migration if persisted contracts or Prisma models change.

## Decision rules

- If a decision would create separate free/pro/premium APIs, do not do it.
- If a decision would move lifecycle ownership away from `Document.processingStatus`, `Job.status/progressPct`, or `DocumentGeneration`, do not do it.
- If a decision would weaken grounding, reject it.
- If a decision would add outside knowledge or inferred facts, reject it.
- If page references are not reliable, prefer section labels or omit references.
- If the source language is clear, output in that language.
- If the document is thin or weak, reduce scope or count instead of filling gaps.
- If long-document coverage and quality conflict, prefer grounded quality first, then balanced coverage.
- If a stronger-model upgrade is considered for summary or flashcards, require benchmark evidence on the same 10 documents before enabling it.
- If a contract change is required, make it explicit and document migration impact before implementation.
- If a legacy compatibility route is unaffected, leave it unchanged and omit it from scope.

## Evaluation workflow

1. Use the same 10 real benchmark documents for every evaluation round.
2. Run prompt-layer validation first with routing held constant.
3. Run routing-policy validation second on the same 10 documents.
4. Evaluate:
   - grounding
   - reference reliability
   - language matching
   - duplicate control
   - weak-document handling
   - summary depth and usefulness
   - flashcard coverage mix and usefulness
   - exam question quality, answerability, and explanation quality
   - contract correctness
   - cost and fallback behavior
5. Record for every run:
   - benchmark document
   - feature
   - tier
   - options
   - prompt version
   - model policy version
   - selected model
   - actual model used
   - fallback usage
   - token usage
   - estimated cost
   - evaluator result
6. Reject a candidate if:
   - grounding regresses
   - unreliable references increase
   - language mismatch appears
   - duplicate output increases materially
   - thin-document behavior becomes more hallucination-prone
   - canonical persistence regresses
   - contract correctness fails
7. Approve a candidate only if:
   - it passes the 10-document set
   - it preserves contracts and lifecycle ownership
   - mock exam quality improves where promised
   - summary and flashcards do not regress
   - cost growth remains controlled

## Rollout notes

- Rollout order:
  1. prompt-layer rollout
  2. model-routing rollout
- Controlled rollout order:
  1. internal testing
  2. benchmark validation
  3. limited production exposure
- Roll back prompt version independently if prompt quality drops.
- Roll back model policy version independently if routing quality or cost control drops.
- Do not require architectural rollback for tier behavior; keep rollback at prompt-version or routing-policy-version level.
- If persisted schema or Prisma changes are introduced, include migration planning and rollback handling before release.

## Acceptance criteria

- One backend AI integration remains in place.
- One prompt framework remains in place.
- Model is resolved per request by policy, not by separate tier architectures.
- Current API contracts remain unchanged unless an explicitly approved change is required.
- `Document.processingStatus`, `Job.status` with `progressPct`, and `DocumentGeneration` retain current ownership boundaries.
- Canonical flashcard and exam records remain correct.
- `options.regenerationGuidance` remains supported and grounded.
- Mock exam remains the highest-priority quality target and receives stronger-model upgrade first where enabled.
- Summary remains a deep adaptive study summary and does not regress.
- Flashcards remain balanced, scaled to document length, and do not regress.
- Thin documents generate only what the source supports.
- Long-document behavior preserves grounded quality while balancing coverage.
- All approvals are based on the same 10 real benchmark documents.
- Prompt version, model policy version, and evaluation results are traceable.
- Any persisted contract or Prisma change is explicitly called out with migration impact before shipping.
