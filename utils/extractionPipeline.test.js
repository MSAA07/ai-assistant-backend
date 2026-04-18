import test from "node:test";
import assert from "node:assert/strict";

import { detectDocumentLanguage, sanitizeExtractedText } from "./extractionPipeline.js";

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
