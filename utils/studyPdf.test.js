import test from "node:test";
import assert from "node:assert/strict";

import { __studyPdfTestables, buildStudyPdfBuffer, buildStudyPdfFileName } from "./studyPdf.js";

test("buildStudyPdfFileName preserves arabic document titles", () => {
  const fileName = buildStudyPdfFileName(
    { originalName: "ملخص المحاضرة النهائية.pdf" },
    "summary",
  );

  assert.equal(fileName, "summary-ملخص المحاضرة النهائية.pdf");
});

test("buildStudyPdfBuffer embeds Arabic-capable fonts for arabic summaries", async () => {
  const buffer = await buildStudyPdfBuffer({
    originalName: "ملف تجريبي",
    language: "arabic",
    summary: "هذا ملخص باللغة العربية لاختبار التصدير النهائي.",
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
  assert.doesNotMatch(pdfText, /Generated /);
  assert.doesNotMatch(pdfText, /Summary/);
});

test("buildStudyPdfBuffer strips raw markdown markers from arabic summaries", async () => {
  const buffer = await buildStudyPdfBuffer({
    originalName: "تلخيص",
    language: "arabic",
    summary: "## الفكرة الرئيسية\n\n- **نقطة أولى**\n- نقطة ثانية\n\n___",
  }, "summary");

  const pdfText = buffer.toString("latin1");
  assert.doesNotMatch(pdfText, /\*\*/);
  assert.doesNotMatch(pdfText, /___/);
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

test("study PDF text normalization fixes Arabic punctuation around ranges and decimals", () => {
  const normalized = __studyPdfTestables.normalizeExportText(
    "من 2021 إلى .2023\nالمعدل 3.15 و،3.33",
  );

  assert.match(normalized, /إلى 2023/);
  assert.match(normalized, /3\.15، و3\.33/);
});
