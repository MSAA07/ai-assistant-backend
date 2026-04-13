# Phase 3 Model Routing Benchmark

Archived rollout record.

This file preserves the benchmark definition used during the routing rollout. It is not the live backend source of truth after the completed rollout and correction passes.

Current runtime truth now lives in:

- `SYSTEM_OVERVIEW.md`
- `PROJECT_STRUCTURE.md`
- `README.md`

This benchmark definition is the fixed evaluation rule for model-routing decisions in Phase 3.

## Benchmark set

Use the same 10 benchmark documents for every routing-policy comparison:

1. Short lecture notes
2. Medium textbook chapter
3. Long dense academic paper
4. Thin or weak extraction case
5. Slide deck with concise bullets
6. Technical process-heavy document
7. Concept-comparison document
8. Definition-heavy study guide
9. Mixed-structure handout with headings and lists
10. Mock-exam-critical source with rich assessment material

## Evaluation matrix

Run the same matrix for every candidate routing policy:

- `summary` on free, pro, premium
- `flashcards` on free, pro, premium
- `exam` on free standard, pro standard, pro high, premium standard, premium high
- fallback runs for any route that can downgrade from stronger model to lower-cost model

## Required metrics

Capture these fields for every run:

- benchmark document id
- feature
- user tier
- requested quality mode
- effective quality mode
- selected model
- actual model used
- fallback used
- input tokens
- output tokens
- estimated cost
- grounding score
- coverage score
- study usefulness score
- answerability score
- contract correctness score
- evaluator notes

## Decision rule

- Mock exam stronger-model routing is approved first.
- Summary and flashcards remain lower-cost-first until the same 10-document suite shows clear quality lift that justifies cost.
- A routing change is not approved if it breaks contract correctness, materially increases hallucination risk, or causes uncontrolled cost growth.
