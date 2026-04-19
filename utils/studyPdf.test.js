import test from "node:test";
import assert from "node:assert/strict";

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

test("buildStudyPdfBuffer emits a PDF buffer for Arabic content", async () => {
  const buffer = await buildStudyPdfBuffer({
    originalName: "ملخص المحاضرة.pdf",
    language: "arabic",
    summary: "## مقدمة\n\n- هذه فقرة عربية للاختبار",
    flashcards: [],
    examQuestions: [],
  }, "summary");

  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 0);
  assert.equal(buffer.subarray(0, 4).toString("ascii"), "%PDF");

  const pdfText = buffer.toString("latin1");
  assert.match(pdfText, /NotoNaskhArabic-Regular/);
  assert.match(pdfText, /NotoNaskhArabic-Bold/);
  assert.match(pdfText, /\/Type0/);
  assert.match(pdfText, /\/ToUnicode/);
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
