import path from "path";

import { sanitizeDownloadFilename } from "./filenames.js";

function encodeRfc5987Value(value) {
  return encodeURIComponent(value)
    .replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildAsciiFilenameFallback(value, fallback = "download") {
  const normalizedValue = sanitizeDownloadFilename(value, fallback);
  const parsedValue = path.parse(normalizedValue);
  const fallbackBaseName = path.parse(sanitizeDownloadFilename(fallback, "download")).name || "download";
  const asciiBaseName = parsedValue.name
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/["\\]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[ ._-]+$/g, "")
    .trim();
  const asciiExtension = parsedValue.ext
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/["\\]/g, "")
    .trim();

  return `${asciiBaseName || fallbackBaseName}${asciiExtension}`;
}

export function buildAttachmentContentDisposition(fileName, fallback = "download") {
  const normalizedFileName = sanitizeDownloadFilename(fileName, fallback);
  const asciiFallback = buildAsciiFilenameFallback(normalizedFileName, fallback);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987Value(normalizedFileName)}`;
}
