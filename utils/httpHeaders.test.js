import test from "node:test";
import assert from "node:assert/strict";

import { buildAttachmentContentDisposition } from "./httpHeaders.js";

test("buildAttachmentContentDisposition includes RFC 5987 UTF-8 filename support", () => {
  const header = buildAttachmentContentDisposition("summary-ملخص المحاضرة.pdf", "summary.pdf");

  assert.match(header, /^attachment; filename="summary\.pdf"; filename\*=UTF-8''/);
  assert.match(header, /summary-%D9%85%D9%84%D8%AE%D8%B5%20%D8%A7%D9%84%D9%85%D8%AD%D8%A7%D8%B6%D8%B1%D8%A9\.pdf$/);
});

test("buildAttachmentContentDisposition preserves mixed-language names", () => {
  const header = buildAttachmentContentDisposition("Chapter 3 - المراجعة النهائية.pdf", "download.pdf");

  assert.match(header, /filename="Chapter 3\.pdf"/);
  assert.match(header, /filename\*=UTF-8''Chapter%203%20-%20%D8%A7%D9%84%D9%85%D8%B1%D8%A7%D8%AC%D8%B9%D8%A9%20%D8%A7%D9%84%D9%86%D9%87%D8%A7%D8%A6%D9%8A%D8%A9\.pdf$/);
});
