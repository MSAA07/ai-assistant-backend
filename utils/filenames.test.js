import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStorageObjectKey,
  getStorageFileExtension,
  normalizeDocumentName,
  normalizeUploadedFilename,
} from "./filenames.js";

test("normalizeUploadedFilename repairs mojibake arabic filenames", () => {
  const rawArabic = "ملخص المحاضرة.pdf";
  const mojibake = Buffer.from(rawArabic, "utf8").toString("latin1");

  assert.equal(normalizeUploadedFilename(mojibake), rawArabic);
});

test("normalizeUploadedFilename preserves mixed Arabic and English filenames", () => {
  const rawName = "Chapter 3 - المراجعة النهائية.docx";
  const mojibake = Buffer.from(rawName, "utf8").toString("latin1");

  assert.equal(normalizeUploadedFilename(mojibake), rawName);
});

test("storage keys keep only a safe extension", () => {
  const rawName = "ملف المراجعة النهائي.PDF";
  const key = buildStorageObjectKey("user-1", rawName);

  assert.match(key, /^uploads\/user-1\/\d+-[a-z0-9]{8}\.pdf$/);
  assert.equal(getStorageFileExtension(rawName), ".pdf");
});

test("normalizeDocumentName repairs mojibake arabic names from persisted rows", () => {
  const rawArabic = "المراجعة النهائية.docx";
  const mojibake = Buffer.from(rawArabic, "utf8").toString("latin1");

  assert.equal(normalizeDocumentName(mojibake), rawArabic);
});
