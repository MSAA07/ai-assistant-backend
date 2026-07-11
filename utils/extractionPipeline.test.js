import test from "node:test";
import assert from "node:assert/strict";

import {
  chunkExtractedTextForExcerpts,
  detectDocumentLanguage,
  parsePdfWithinPageLimit,
  sanitizeExtractedText,
} from "./extractionPipeline.js";

const oversizedPdfFixture = new URL("../tests/qa-test-oversized.pdf", import.meta.url);
const normalPdfFixture = new URL("../tests/arabic.pdf", import.meta.url);

function createExcerpt(content) {
  return {
    content,
  };
}

test("detectDocumentLanguage recognizes spanish latin-script content", () => {
  const language = detectDocumentLanguage([
    createExcerpt("La fotosintesis es el proceso por el que las plantas convierten la luz en energia."),
    createExcerpt("El contenido del documento explica conceptos, definiciones y procesos con ejemplos."),
  ]);

  assert.equal(language, "spanish");
});

test("chunkExtractedTextForExcerpts preserves later PDF text instead of truncating", () => {
  const start = "Consumer buyer behavior ".repeat(140);
  const middle = "Maslow hierarchy adoption process ".repeat(120);
  const end = "buying center e-procurement business buying situations ".repeat(90);
  const chunks = chunkExtractedTextForExcerpts(`${start}${middle}${end}`, {
    slideOrPage: 7,
    excerptType: "slide_text",
  });
  const combined = chunks.map((chunk) => chunk.content).join(" ");

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.content.length <= 3000));
  assert.ok(chunks.every((chunk) => chunk.slideOrPage === 7));
  assert.equal(chunks[0].charOffset, 0);
  assert.ok(chunks.at(-1).charOffset > 0);
  assert.match(combined, /Maslow hierarchy adoption process/);
  assert.match(combined, /buying center e-procurement/);
});

test("detectDocumentLanguage recognizes japanese content", () => {
  const language = detectDocumentLanguage([
    createExcerpt("これは学習資料です。重要な概念と手順を説明します。"),
  ]);

  assert.equal(language, "japanese");
});

test("detectDocumentLanguage recognizes arabic content", () => {
  const language = detectDocumentLanguage([
    createExcerpt("هذا المستند يشرح المفاهيم الأساسية والخطوات المطلوبة لإكمال المهمة."),
    createExcerpt("يحتوي الملف على تعريفات وأمثلة وتلخيص للمراجعة النهائية."),
  ]);

  assert.equal(language, "arabic");
});

test("sanitizeExtractedText repairs mojibake arabic text", () => {
  const rawArabic = "ملخص المحاضرة النهائية";
  const mojibake = Buffer.from(rawArabic, "utf8").toString("latin1");

  assert.equal(sanitizeExtractedText(mojibake), rawArabic);
});

test("parsePdfWithinPageLimit rejects PDFs above 200 pages with an upload-safe error", async () => {
  await assert.rejects(
    parsePdfWithinPageLimit(oversizedPdfFixture),
    (error) => error?.code === "document_too_long"
      && error?.statusCode === 422
      && /200 pages or fewer/.test(error.message),
  );
});

test("parsePdfWithinPageLimit accepts a normal PDF", async () => {
  const data = await parsePdfWithinPageLimit(normalPdfFixture);

  assert.equal(data.numpages, 140);
});
