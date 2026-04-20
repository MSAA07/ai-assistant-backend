# PDF Layout Spec

Canonical source of truth for English PDF exports in `backend/utils/studyPdf.js`.

## Page Layout

- Page size: `A4`
- Margins:
  - top: `40`
  - bottom: `40`
  - left: `48`
  - right: `48`
- Content container:
  - centered on page
  - max readable width: `468`
  - body text must not render full-width across the page

## Spacing Scale

Allowed spacing values only:

- `4`
- `8`
- `16`
- `24`
- `32`
- `40`

All spacing in renderer components must map to this scale.

## Typography Scale

- Document Title: `22px`, `700`
- Section Title: `16px`, `700`
- Question Text: `13.5px`, `600`
- Flashcard Question: `12.5px`, `600`
- Body Text: `11.5px`, `400`
- Labels: `10px`, `700`
- Meta Text: `10px`, `400`

Hierarchy rules:

- headings > questions > body
- question text > answer text
- question text > options
- labels must be smaller and more muted than content

## Normalization Rules

Before rendering:

- remove stray line breaks inside sentences
- preserve paragraph breaks
- remove empty lines inside sentences
- normalize spacing around punctuation
- normalize spacing around parentheses and brackets
- normalize repeated spaces and tabs

Sentence text must not render with empty-line breaks inside a sentence.

## Wrapping Rules

- enforce readable container width
- avoid single-word final lines where possible
- rebalance narrow last lines by moving one token from previous line when safe
- avoid awkward sentence splits by normalizing text before wrapping

## Component Rules

### Summary

- paragraphs must be normalized before render
- hyphen lists must convert to bullets
- content should be grouped into readable sections where possible
- no text walls

### Flashcards

- each flashcard is a card component
- card padding: `24`
- gap between cards: `32`
- card structure:
  - Question label
  - question text
  - Answer label
  - answer text
  - optional Explanation label + body
- card must use a border or light panel background

### Exam

- each question is a question block
- block padding: `24`
- gap between questions: `32`
- block structure:
  - Question X label
  - emphasized question text
  - divider
  - indented options list
- option indent: `24`
- option gap: `8`

## Acceptance Criteria

- clear visual hierarchy exists at a glance
- flashcards read as cards, not plain text
- exam questions are instantly scannable
- summary paragraphs are readable and normalized
- no broken lines exist inside sentences
- no typography or spacing drift outside the approved scale
