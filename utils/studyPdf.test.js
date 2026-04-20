import test from "node:test";
import assert from "node:assert/strict";
import PDFDocument from "pdfkit";

import { __studyPdfTestables, buildStudyPdfBuffer, buildStudyPdfFileName } from "./studyPdf.js";

test("buildStudyPdfFileName preserves Arabic and mixed-language document names", () => {
  assert.equal(
    buildStudyPdfFileName({ originalName: "ملخص المحاضرة.pdf" }, "summary"),
    "summary-ملخص المحاضرة.pdf",
  );

  assert.equal(
    buildStudyPdfFileName({ originalName: "Chapter 3 - المراجعة النهائية.docx" }, "flashcards"),
    "flashcards-Chapter 3 - المراجعة النهائية.pdf",
  );
});

test("pdf system uses the canonical layout and typography spec", () => {
  const { PDF_SYSTEM } = __studyPdfTestables;

  assert.equal(PDF_SYSTEM.page.size, "A4");
  assert.deepEqual(PDF_SYSTEM.page.margins, {
    top: 40,
    bottom: 40,
    left: 48,
    right: 48,
  });
  assert.equal(PDF_SYSTEM.page.maxContentWidth, 468);

  assert.equal(PDF_SYSTEM.typography.documentTitle.size, 22);
  assert.equal(PDF_SYSTEM.typography.sectionTitle.size, 16);
  assert.equal(PDF_SYSTEM.typography.questionText.size, 13.5);
  assert.equal(PDF_SYSTEM.typography.flashcardQuestion.size, 12.5);
  assert.equal(PDF_SYSTEM.typography.body.size, 11.5);
  assert.equal(PDF_SYSTEM.typography.label.size, 10);
});

test("pdf system spacing uses only approved scale values", () => {
  const allowed = new Set([4, 8, 16, 24, 32, 40]);
  const { PDF_SYSTEM } = __studyPdfTestables;

  const values = [
    ...Object.values(PDF_SYSTEM.spacing),
    PDF_SYSTEM.components.flashcard.padding,
    PDF_SYSTEM.components.flashcard.gapBetweenCards,
    PDF_SYSTEM.components.flashcard.sectionGap,
    PDF_SYSTEM.components.exam.padding,
    PDF_SYSTEM.components.exam.gapBetweenQuestions,
    PDF_SYSTEM.components.exam.optionsGap,
    PDF_SYSTEM.components.exam.optionIndent,
    PDF_SYSTEM.components.exam.dividerGap,
    PDF_SYSTEM.components.summary.paragraphGap,
    PDF_SYSTEM.components.summary.listItemGap,
    PDF_SYSTEM.components.summary.sectionGap,
  ];

  values.forEach((value) => {
    assert.ok(allowed.has(value), `unexpected spacing value: ${value}`);
  });
});

test("buildStudyPdfBuffer emits a PDF buffer for Arabic content", async () => {
  const buffer = await buildStudyPdfBuffer({
    originalName: "ملخص المحاضرة.pdf",
    summary: "## مقدمة\n\n- هذه فقرة عربية للاختبار",
    flashcards: [],
    examQuestions: [],
  }, "summary");

  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 0);
  assert.equal(buffer.subarray(0, 4).toString("ascii"), "%PDF");
});

test("study PDF text preprocessing applies bidi-safe visual ordering for Arabic mixed with numbers and codes", () => {
  const visual = __studyPdfTestables.toVisualPdfText("مقدمة في CS101 (2026): المحاضرة 3", "rtl");

  assert.equal(
    visual,
    "3 المحاضرة :CS101 (2026) في مقدمة",
  );
  assert.match(visual, /CS101 \(2026\)/);
});

test("study PDF text preprocessing preserves English-first mixed titles while shaping Arabic", () => {
  const title = "Chapter 3 - المراجعة النهائية";

  assert.equal(__studyPdfTestables.getTextDirection(title), "ltr");
  assert.equal(
    __studyPdfTestables.toVisualPdfText(title, "ltr"),
    "Chapter 3 - النهائية المراجعة",
  );
});

test("summary parsing converts inline hyphen text into structured bullet lists", () => {
  const blocks = __studyPdfTestables.parseSummaryBlocks(
    "Leadership expectations - stakeholder communication - escalation handling",
  );

  assert.deepEqual(blocks, [
    {
      type: "list",
      items: [
        "Leadership expectations",
        "stakeholder communication",
        "escalation handling",
      ],
    },
  ]);
});

test("summary section builder produces the required English export sections", () => {
  const sections = __studyPdfTestables.buildSummarySections(`
## Core Themes

The candidate should explain system design tradeoffs clearly.

## Assessment Criteria

- Communication
- Technical depth

## Interview Flow

Opening discussion. Deep dive on project decisions. Final wrap-up.
  `);

  assert.deepEqual(
    sections.map((section) => section.title),
    ["Key Themes", "Assessment Areas", "Interview Structure"],
  );
  assert.ok(sections[0].blocks.length > 0);
  assert.ok(sections[1].blocks.length > 0);
  assert.ok(sections[2].blocks.length > 0);
});

test("paragraph normalization removes accidental line breaks inside sentences", () => {
  assert.equal(
    __studyPdfTestables.normalizeParagraphText("First line\ncontinues here\n\nNext paragraph"),
    "First line continues here\n\nNext paragraph",
  );
});

test("inline spacing normalization fixes punctuation and parenthesis spacing", () => {
  assert.equal(
    __studyPdfTestables.normalizeInlineSpacing("Hello ,world!This is ( spaced ) text 2026/04/19 +noise"),
    "Hello, world! This is (spaced) text 2026/04/19 + noise",
  );
});

test("paragraph normalization preserves hyphenated compounds while cleaning stray breaks", () => {
  assert.equal(
    __studyPdfTestables.normalizeParagraphText("cross-functional\nresponse plan"),
    "cross-functional response plan",
  );
});

test("logical wrapping rebalances a single-word final line", () => {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  __studyPdfTestables.registerPdfFonts(doc);
  doc.font("Helvetica").fontSize(11);

  const lines = __studyPdfTestables.wrapLogicalText(
    doc,
    "This exam block should avoid leaving isolated trailing words",
    180,
    "ltr",
  );

  assert.ok(lines.length >= 2);
  assert.notEqual(lines.at(-1)?.trim().split(/\s+/).length, 1);
});

test("exam question block measurement includes question content and options", () => {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  __studyPdfTestables.registerPdfFonts(doc);
  doc.font("Helvetica").fontSize(11);

  const compact = __studyPdfTestables.measureExamQuestionBlock(doc, {
    question: "What is the best answer?",
    options: ["A short option"],
  }, 0, 320);

  const expanded = __studyPdfTestables.measureExamQuestionBlock(doc, {
    question: "What is the best answer?",
    options: [
      "A much longer option that should take more than one visual line in the PDF block layout",
      "Another detailed option for sizing coverage",
    ],
  }, 0, 320);

  assert.ok(expanded > compact);
});

test("canonical hierarchy keeps questions above body text and labels below both", () => {
  const { PDF_SYSTEM } = __studyPdfTestables;

  assert.ok(PDF_SYSTEM.typography.questionText.size > PDF_SYSTEM.typography.body.size);
  assert.ok(PDF_SYSTEM.typography.flashcardQuestion.size > PDF_SYSTEM.typography.body.size);
  assert.ok(PDF_SYSTEM.typography.body.size > PDF_SYSTEM.typography.label.size);
});
