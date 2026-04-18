import test from "node:test";
import assert from "node:assert/strict";

import { buildStudyPdfBuffer, buildStudyPdfFileName } from "./studyPdf.js";

test("buildStudyPdfFileName preserves arabic document titles", () => {
  const fileName = buildStudyPdfFileName(
    { originalName: "ملخص المحاضرة النهائية.pdf" },
    "summary",
  );

  assert.equal(fileName, "summary-ملخص-المحاضرة-النهائية.pdf");
});

test("buildStudyPdfBuffer embeds Arabic-capable fonts for arabic summaries", async () => {
  const pdfBuffer = await buildStudyPdfBuffer({
    originalName: "ملف تجريبي",
    language: "arabic",
    summary: "هذا ملخص باللغة العربية لاختبار التصدير النهائي.",
  }, "summary");
  const pdfText = pdfBuffer.toString("latin1");

  assert.match(pdfText, /NotoNaskhArabic-Regular/);
  assert.match(pdfText, /NotoNaskhArabic-Bold/);
  assert.match(pdfText, /\/Type0/);
  assert.match(pdfText, /\/ToUnicode/);
});
