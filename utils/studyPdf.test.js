import test from "node:test";
import assert from "node:assert/strict";

import { __studyPdfTestables, buildStudyPdfBuffer, buildStudyPdfFileName } from "./studyPdf.js";

test("buildStudyPdfFileName preserves arabic document titles", () => {
  const fileName = buildStudyPdfFileName(
    { originalName: "\u0645\u0644\u062e\u0635 \u0627\u0644\u0645\u062d\u0627\u0636\u0631\u0629 \u0627\u0644\u0646\u0647\u0627\u0626\u064a\u0629.pdf" },
    "summary",
  );

  assert.equal(fileName, "summary-\u0645\u0644\u062e\u0635 \u0627\u0644\u0645\u062d\u0627\u0636\u0631\u0629 \u0627\u0644\u0646\u0647\u0627\u0626\u064a\u0629.pdf");
});

test("buildStudyPdfBuffer embeds Arabic-capable fonts for arabic summaries", async () => {
  const buffer = await buildStudyPdfBuffer({
    originalName: "\u0645\u0644\u0641 \u062a\u062c\u0631\u064a\u0628\u064a",
    language: "arabic",
    summary: "\u0647\u0630\u0627 \u0645\u0644\u062e\u0635 \u0628\u0627\u0644\u0644\u063a\u0629 \u0627\u0644\u0639\u0631\u0628\u064a\u0629 \u0644\u0627\u062e\u062a\u0628\u0627\u0631 \u0627\u0644\u062a\u0635\u062f\u064a\u0631 \u0627\u0644\u0646\u0647\u0627\u0626\u064a.",
  }, "summary");

  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 0);
  assert.equal(buffer.subarray(0, 4).toString("ascii"), "%PDF");

  const pdfText = buffer.toString("latin1");
  assert.match(pdfText, /NotoNaskhArabic-Regular/);
  assert.match(pdfText, /NotoNaskhArabic-Bold/);
  assert.match(pdfText, /\/Type0/);
  assert.match(pdfText, /\/ToUnicode/);
  assert.doesNotMatch(pdfText, /Study Hub export/);
  assert.doesNotMatch(pdfText, /Generated at/);
  assert.doesNotMatch(pdfText, /Summary/);
  assert.doesNotMatch(pdfText, /\*\*/);
  assert.doesNotMatch(pdfText, /___/);
});

test("arabic flashcard export does not leak English labels", async () => {
  const buffer = await buildStudyPdfBuffer({
    originalName: "\u0645\u0630\u0627\u0643\u0631\u0629 \u0647\u064a\u0627\u0643\u0644 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a",
    language: "arabic",
    flashcards: [{
      question: "\u0645\u0627 \u0647\u0648 CS101\u061f",
      answer: "\u0645\u0642\u0631\u0631 \u062a\u0645\u0647\u064a\u062f\u064a \u0641\u064a \u0639\u0644\u0648\u0645 \u0627\u0644\u062d\u0627\u0633\u0628.",
      explanation: "\u064a\u0634\u0645\u0644 \u0623\u0633\u0627\u0633\u064a\u0627\u062a \u0627\u0644\u0628\u0631\u0645\u062c\u0629 \u0648\u0627\u0644\u062e\u0648\u0627\u0631\u0632\u0645\u064a\u0627\u062a.",
    }],
  }, "flashcards");

  const pdfText = buffer.toString("latin1");
  assert.doesNotMatch(pdfText, /Flashcards/);
  assert.doesNotMatch(pdfText, /\bQ:/);
  assert.doesNotMatch(pdfText, /\bA:/);
  assert.doesNotMatch(pdfText, /Explanation:/);
});

test("arabic exam export does not leak English labels", async () => {
  const buffer = await buildStudyPdfBuffer({
    originalName: "\u0627\u062e\u062a\u0628\u0627\u0631 \u0627\u0644\u0645\u0631\u0627\u062c\u0639\u0629",
    language: "arabic",
    examQuestions: [{
      question: "\u0645\u0627 \u0647\u0648 \u0648\u0635\u0641 \u0645\u0642\u0631\u0631 CS202 \u0641\u064a \u0639\u0627\u0645 2023\u061f",
      options: [
        "\u0645\u0642\u0631\u0631 \u064a\u0631\u0643\u0632 \u0639\u0644\u0649 \u0647\u064a\u0627\u0643\u0644 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a.",
        "\u0645\u0642\u0631\u0631 \u0641\u064a \u062a\u062d\u0644\u064a\u0644 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a.",
      ],
    }],
  }, "exam");

  const pdfText = buffer.toString("latin1");
  assert.doesNotMatch(pdfText, /Exam/);
  assert.doesNotMatch(pdfText, /Question 1/);
  assert.doesNotMatch(pdfText, /Option A/);
  assert.doesNotMatch(pdfText, /Option B/);
});

test("study PDF text preprocessing applies bidi-safe visual ordering for Arabic mixed with numbers and codes", () => {
  const visual = __studyPdfTestables.toVisualPdfText(
    "\u0645\u0642\u062f\u0645\u0629 \u0641\u064a CS101 (2026): \u0627\u0644\u0645\u062d\u0627\u0636\u0631\u0629 3",
    "rtl",
  );

  assert.equal(
    visual,
    "3 \u0627\u0644\u0645\u062d\u0627\u0636\u0631\u0629 :CS101 (2026) \u0641\u064a \u0645\u0642\u062f\u0645\u0629",
  );
  assert.match(visual, /CS101 \(2026\)/);
});

test("study PDF text preprocessing preserves English-first mixed titles while shaping Arabic", () => {
  const title = "Chapter 3 - \u0627\u0644\u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u0646\u0647\u0627\u0626\u064a\u0629";

  assert.equal(__studyPdfTestables.getTextDirection(title), "ltr");
  assert.equal(
    __studyPdfTestables.toVisualPdfText(title, "ltr"),
    "Chapter 3 - \u0627\u0644\u0646\u0647\u0627\u0626\u064a\u0629 \u0627\u0644\u0645\u0631\u0627\u062c\u0639\u0629",
  );
});

test("study PDF text normalization fixes Arabic punctuation around ranges and decimals", () => {
  const normalized = __studyPdfTestables.normalizeExportText(
    "\u0645\u0646 2021 \u0625\u0644\u0649 .2023\n\u0627\u0644\u0645\u0639\u062f\u0644 3.15 \u0648\u060c3.33",
  );

  assert.match(normalized, /\u0625\u0644\u0649 2023/);
  assert.match(normalized, /3\.15\u060c \u06483\.33/);
});
