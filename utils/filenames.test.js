import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStorageObjectKey,
  getStorageFileExtension,
  normalizeUploadedFilename,
} from "./filenames.js";

test("normalizeUploadedFilename preserves Arabic filenames", () => {
  const mojibake = "ÙÙØ®Øµ Ø§ÙÙØ­Ø§Ø¶Ø±Ø©.pdf";
  assert.equal(normalizeUploadedFilename(mojibake), "ملخص المحاضرة.pdf");
});

test("normalizeUploadedFilename preserves mixed Arabic and English filenames", () => {
  const mojibake = "Chapter 3 - Ø§ÙÙØ±Ø§Ø¬Ø¹Ø© Ø§ÙÙÙØ§Ø¦ÙØ©.docx";
  assert.equal(normalizeUploadedFilename(mojibake), "Chapter 3 - المراجعة النهائية.docx");
});

test("storage keys keep only a safe extension", () => {
  const key = buildStorageObjectKey("user-1", "ملف المراجعة النهائي.PDF");
  assert.match(key, /^uploads\/user-1\/\d+-[a-z0-9]{8}\.pdf$/);
  assert.equal(getStorageFileExtension("ملف المراجعة النهائي.PDF"), ".pdf");
});
