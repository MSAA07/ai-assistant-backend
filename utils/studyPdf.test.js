import test from "node:test";
import assert from "node:assert/strict";
import PDFDocument from "pdfkit";

import { __studyPdfTestables, buildStudyPdfBuffer, buildStudyPdfFileName } from "./studyPdf.js";

test("buildStudyPdfFileName uses the canonical document-feature format", () => {
  assert.equal(
    buildStudyPdfFileName({ originalName: "ملخص المحاضرة.pdf" }, "summary"),
    "ملخص_المحاضرة-summary.pdf",
  );

  assert.equal(
    buildStudyPdfFileName({ originalName: "Chapter 3 - المراجعة النهائية.docx" }, "flashcards"),
    "Chapter_3_-_المراجعة_النهائية-flashcards.pdf",
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
  assert.equal(PDF_SYSTEM.typography.flashcardQuestion.size, 10.5);
  assert.equal(PDF_SYSTEM.typography.body.size, 9.5);
  assert.equal(PDF_SYSTEM.typography.label.size, 9);
});

test("pdf system spacing uses only approved scale values", () => {
  const allowed = new Set([0, 2, 4, 8, 16, 24, 32, 40]);
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

test("component spacing is identical across similar PDF blocks", () => {
  const { PDF_SYSTEM } = __studyPdfTestables;

  assert.equal(PDF_SYSTEM.components.flashcard.padding, 16);
  assert.equal(PDF_SYSTEM.components.flashcard.gapBetweenCards, 8);
  assert.equal(PDF_SYSTEM.components.flashcard.sectionGap, 8);
  assert.equal(PDF_SYSTEM.components.exam.padding, 16);
  assert.equal(PDF_SYSTEM.components.exam.gapBetweenQuestions, 8);
  assert.equal(PDF_SYSTEM.components.exam.optionsGap, 4);
  assert.equal(PDF_SYSTEM.components.exam.dividerGap, 8);
  assert.equal(PDF_SYSTEM.components.summary.paragraphGap, 16);
  assert.equal(PDF_SYSTEM.components.summary.listItemGap, 8);
});

test("header title layout never exceeds content width and stays within two lines", () => {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  __studyPdfTestables.registerPdfFonts(doc);

  const contentWidth = 468;
  const longTitle = "This is an intentionally long study document title designed to test wrapping and scaling behavior without horizontal overflow";
  const layout = __studyPdfTestables.fitHeaderTitleLayout(doc, longTitle, contentWidth);

  assert.ok(layout.lines.length <= 2);
  assert.ok(layout.fontSize >= __studyPdfTestables.PDF_SYSTEM.typography.documentTitle.size * 0.85);

  layout.lines.forEach((line) => {
    doc.fontSize(layout.fontSize);
    const lineWidth = doc.widthOfString(__studyPdfTestables.toVisualPdfText(line, layout.direction));
    assert.ok(lineWidth <= contentWidth, `line overflowed content width: ${lineWidth} > ${contentWidth}`);
  });
});

test("header stack metrics stay within content container and tight safe-zone rhythm", () => {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  __studyPdfTestables.registerPdfFonts(doc);

  const metrics = __studyPdfTestables.computeHeaderLayoutMetrics(doc, "english_heavy_test", "Flashcards");
  const { container, spacing } = metrics;

  assert.equal(container.width, __studyPdfTestables.PDF_SYSTEM.page.maxContentWidth);
  assert.equal(spacing.titleToFeatureGap, 4);
  assert.equal(spacing.featureToMetaGap, 4);
  assert.equal(spacing.dividerBefore, 4);
  assert.equal(spacing.dividerAfter, 8);
  assert.ok(metrics.totalHeight < 100, `header is too tall: ${metrics.totalHeight}`);
});

test("header title fitting uses wrap-first strategy and scales/truncates only when needed", () => {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  __studyPdfTestables.registerPdfFonts(doc);

  const shortLayout = __studyPdfTestables.fitHeaderTitleLayout(doc, "english_heavy_test", 468);
  assert.equal(shortLayout.lines.length, 1);
  assert.equal(shortLayout.truncated, false);
  assert.equal(shortLayout.fontSize, __studyPdfTestables.PDF_SYSTEM.typography.documentTitle.size);

  const veryLongLayout = __studyPdfTestables.fitHeaderTitleLayout(
    doc,
    "A very long document title that should still remain in the header safe zone and never overflow the aligned content boundary across export pages and rendering variants",
    320,
  );
  assert.ok(veryLongLayout.lines.length <= 2);
  assert.ok(veryLongLayout.fontSize >= __studyPdfTestables.PDF_SYSTEM.typography.documentTitle.size * 0.85);
});

test("header metrics cap long title to two lines and retain aligned width", () => {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  __studyPdfTestables.registerPdfFonts(doc);

  const longMetrics = __studyPdfTestables.computeHeaderLayoutMetrics(
    doc,
    "A very long document title that should still remain in the header safe zone and never overflow the aligned content boundary across export pages and rendering variants",
    "Flashcards",
  );

  assert.ok(longMetrics.titleLayout.lines.length <= 2);
  assert.ok(longMetrics.container.width <= __studyPdfTestables.PDF_SYSTEM.page.maxContentWidth);
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

test("summary parsing recognizes normalized bullet glyph lists", () => {
  const blocks = __studyPdfTestables.parseSummaryBlocks("• first point\n• second point");

  assert.deepEqual(blocks, [
    {
      type: "list",
      items: ["first point", "second point"],
    },
  ]);
});

test("summary section builder preserves actual summary section labels", () => {
  const sections = __studyPdfTestables.buildSummarySections(`
Title: Understanding Consumer and Business Buyer Behavior
Core Definition: Consumer behavior covers final consumers, while business buyer behavior covers organizational purchasing.
Main Sections:
- Consumer Buyer Behavior:
  - Cultural factors
  - Social factors
- Business Buyer Behavior:
  - Straight rebuy
  - Modified rebuy
Quick Revision:
- Consumer vs. business distinctions
Common Pitfalls:
- Mixing consumer decision stages with business buying steps
  `);

  assert.deepEqual(
    sections.map((section) => section.title),
    ["Title", "Core Definition", "Main Sections", "Quick Revision", "Common Pitfalls"],
  );
  assert.ok(sections[0].blocks.length > 0);
  assert.ok(sections[2].blocks.length > 0);
});

test("summary section builder does not create empty placeholder sections", () => {
  const sections = __studyPdfTestables.buildSummarySections(`
Title: Short Summary
Quick Revision:
- Recall point one
  `);

  assert.deepEqual(
    sections.map((section) => section.title),
    ["Title", "Quick Revision"],
  );
});

test("summary pdf section builder preserves nested list levels for hierarchy", () => {
  const sections = __studyPdfTestables.buildSummarySectionsForPdf(`
Main Sections:
- Consumer Buyer Behavior:
  - Cultural factors
  - Social factors
- Business Buyer Behavior:
  - Straight rebuy
  - Modified rebuy
  `);

  assert.equal(sections[0].title, "Main Sections");
  assert.deepEqual(
    sections[0].blocks[0].items,
    [
      { text: "Consumer Buyer Behavior:", level: 0, ordered: false, marker: "-" },
      { text: "Cultural factors", level: 1, ordered: false, marker: "-" },
      { text: "Social factors", level: 1, ordered: false, marker: "-" },
      { text: "Business Buyer Behavior:", level: 0, ordered: false, marker: "-" },
      { text: "Straight rebuy", level: 1, ordered: false, marker: "-" },
      { text: "Modified rebuy", level: 1, ordered: false, marker: "-" },
    ],
  );
});

test("paragraph normalization removes accidental line breaks inside sentences", () => {
  assert.equal(
    __studyPdfTestables.normalizeParagraphText("First line\ncontinues here\n\nNext paragraph"),
    "First line continues here\n\nNext paragraph",
  );
});

test("paragraph normalization removes empty lines inside a sentence", () => {
  assert.equal(
    __studyPdfTestables.normalizeParagraphText("What is discussed in\n\nthe study material?"),
    "What is discussed in the study material?",
  );
  assert.doesNotMatch(
    __studyPdfTestables.normalizeParagraphText("What is discussed in\n\nthe study material?"),
    /\n/,
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

test("summary parsing isolates Example Case into its own paragraph block", () => {
  const blocks = __studyPdfTestables.parseSummaryBlocks(
    "Leadership expectations. Example Case: The candidate explains a product outage clearly. Next, they propose a response plan.",
  );

  assert.deepEqual(blocks, [
    { type: "paragraph", text: "Leadership expectations." },
    { type: "paragraph", text: "Example Case: The candidate explains a product outage clearly. Next, they propose a response plan." },
  ]);
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

test("drawWrappedText with advanceCursor=false does not mutate doc.y", () => {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  __studyPdfTestables.registerPdfFonts(doc);

  const startY = doc.y;
  const consumed = __studyPdfTestables.drawWrappedText(doc, "Question 1", {
    x: 64,
    y: startY + 20,
    width: 320,
    fontSize: 12.5,
    lineGap: 4,
    advanceCursor: false,
  });

  assert.ok(consumed > 0);
  assert.equal(doc.y, startY);
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

test("exam question typing and render options default true/false choices correctly", () => {
  assert.equal(__studyPdfTestables.getExamQuestionType({ questionType: "mcq", options: ["A", "B"] }), "mcq");
  assert.equal(__studyPdfTestables.getExamQuestionType({ type: "true_false", options: [] }), "true_false");
  assert.equal(__studyPdfTestables.getExamQuestionType({ options: [] }), "true_false");

  assert.deepEqual(
    __studyPdfTestables.getRenderableExamOptions({ questionType: "true_false", options: [] }),
    ["True", "False"],
  );
  assert.deepEqual(
    __studyPdfTestables.getRenderableExamOptions({ questionType: "mcq", options: ["A", "B"] }),
    ["A", "B"],
  );

  assert.equal(__studyPdfTestables.getExamOptionLabel("mcq", 0), "A.");
  assert.equal(__studyPdfTestables.getExamOptionLabel("mcq", 1), "B.");
  assert.equal(__studyPdfTestables.getExamOptionLabel("true_false", 0), "");
});

test("exam ordering keeps multiple choice before true/false questions", () => {
  const ordered = __studyPdfTestables.orderExamQuestionsForPdf([
    { question: "TF 1", questionType: "true_false" },
    { question: "MCQ 1", questionType: "mcq", options: ["A", "B"] },
    { question: "TF 2", questionType: "true_false" },
    { question: "MCQ 2", questionType: "multiple_choice", options: ["A", "B"] },
  ]);

  assert.deepEqual(
    ordered.map((entry) => entry.question),
    ["MCQ 1", "MCQ 2", "TF 1", "TF 2"],
  );
});

test("exam section label is mock exam", () => {
  assert.equal(__studyPdfTestables.FEATURE_LABELS.exam, "Mock Exam");
});

test("canonical hierarchy keeps questions above body text and labels below both", () => {
  const { PDF_SYSTEM } = __studyPdfTestables;

  assert.ok(PDF_SYSTEM.typography.questionText.size > PDF_SYSTEM.typography.body.size);
  assert.ok(PDF_SYSTEM.typography.flashcardQuestion.size > PDF_SYSTEM.typography.body.size);
  assert.ok(PDF_SYSTEM.typography.body.size > PDF_SYSTEM.typography.label.size);
});

test("flashcards and exam blocks retain component styling instead of plain text spacing", () => {
  const { PDF_SYSTEM } = __studyPdfTestables;

  assert.ok(PDF_SYSTEM.components.flashcard.padding >= 16 && PDF_SYSTEM.components.flashcard.padding <= 20);
  assert.equal(PDF_SYSTEM.components.flashcard.gapBetweenCards, 8);
  assert.equal(PDF_SYSTEM.components.exam.gapBetweenQuestions, 8);
  assert.ok(PDF_SYSTEM.components.exam.optionIndent >= PDF_SYSTEM.components.summary.listItemGap);
});

test("flashcard vertical rhythm uses one strict inter-card spacing value", () => {
  const { PDF_SYSTEM } = __studyPdfTestables;

  assert.equal(PDF_SYSTEM.components.flashcard.gapBetweenCards, 8);
});

test("first card starts immediately after header and each next card advances by one gap only", () => {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  __studyPdfTestables.registerPdfFonts(doc);

  const header = __studyPdfTestables.computeHeaderLayoutMetrics(doc, "english_heavy_test", "Flashcards");
  const startY = __studyPdfTestables.PDF_SYSTEM.page.margins.top + header.totalHeight;
  const flashcards = [
    { question: "Q1", answer: "A1" },
    { question: "Q2", answer: "A2" },
    { question: "Q3", answer: "A3" },
  ];
  const plan = __studyPdfTestables.computeFlashcardLayoutPlan(doc, flashcards, startY);

  assert.equal(plan.cards[0].yStart, startY);
  for (let index = 0; index < plan.cards.length - 1; index += 1) {
    const current = plan.cards[index];
    const next = plan.cards[index + 1];
    assert.equal(current.gapAfter, __studyPdfTestables.PDF_SYSTEM.components.flashcard.gapBetweenCards);
    assert.equal(next.yStart - (current.yStart + current.cardHeight), current.gapAfter);
  }
  assert.equal(plan.cards.at(-1)?.gapAfter ?? -1, 0);
});
