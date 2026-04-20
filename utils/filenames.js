import path from "path";

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const MOJIBAKE_MARKERS = /[ÃÂÐÑØÙ]/g;
const ARABIC_CHARS = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g;
const LATIN_CHARS = /[A-Za-z]/g;
const DIGITS = /\d/g;
const REPLACEMENT_CHARS = /\uFFFD/g;
const RESERVED_FILENAME_CHARS = /[<>:"/\\|?*]/g;
const TRAILING_WINDOWS_CHARS = /[. ]+$/g;

function normalizeString(value) {
  return typeof value === "string" ? value : "";
}

function countMatches(pattern, value) {
  return (value.match(pattern) || []).length;
}

function stripDirectorySegments(value) {
  return value.split(/[/\\]/).pop() ?? "";
}

function sanitizeFilenameText(value) {
  return normalizeString(value)
    .replace(CONTROL_CHARS, "")
    .trim()
    .normalize("NFC");
}

function replaceReservedFilenameChars(value) {
  return sanitizeFilenameText(value)
    .replace(RESERVED_FILENAME_CHARS, " ")
    .replace(/\s+/g, " ")
    .replace(TRAILING_WINDOWS_CHARS, "")
    .trim();
}

function scoreFilename(value) {
  const source = sanitizeFilenameText(value);
  if (!source) {
    return Number.NEGATIVE_INFINITY;
  }

  return (countMatches(ARABIC_CHARS, source) * 5)
    + (countMatches(LATIN_CHARS, source) * 2)
    + countMatches(DIGITS, source)
    - (countMatches(MOJIBAKE_MARKERS, source) * 4)
    - (countMatches(REPLACEMENT_CHARS, source) * 8);
}

function decodeUtf8FromLatin1(value) {
  try {
    const bytes = Uint8Array.from(value, (char) => char.charCodeAt(0) & 0xff);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return value;
  }
}

export function repairPotentialUnicodeCorruption(value) {
  const source = sanitizeFilenameText(value);
  if (!source) {
    return "";
  }

  const candidate = sanitizeFilenameText(decodeUtf8FromLatin1(source));
  if (!candidate || candidate === source || candidate.includes("\uFFFD")) {
    return source;
  }

  const hasArabicRecovery = countMatches(ARABIC_CHARS, candidate) > countMatches(ARABIC_CHARS, source);
  const improvedScore = scoreFilename(candidate) >= scoreFilename(source) + 2;

  return hasArabicRecovery || improvedScore ? candidate : source;
}

export function normalizeDocumentName(value) {
  return repairPotentialUnicodeCorruption(value);
}

export function normalizeUploadedFilename(value) {
  const stripped = stripDirectorySegments(value);
  return repairPotentialUnicodeCorruption(stripped);
}

export function sanitizeDownloadFilename(value, fallback = "document") {
  const normalizedFallback = replaceReservedFilenameChars(fallback) || "document";
  return replaceReservedFilenameChars(value) || normalizedFallback;
}

export function getStorageFileExtension(originalFilename) {
  const normalizedName = normalizeUploadedFilename(originalFilename);
  const extension = path.extname(normalizedName);
  return /^[.][A-Za-z0-9]{1,10}$/.test(extension) ? extension.toLowerCase() : "";
}

export function buildStorageObjectKey(userId, originalFilename) {
  const extension = getStorageFileExtension(originalFilename);
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `uploads/${userId}/${Date.now()}-${randomPart}${extension}`;
}

export function getDocumentDisplayName(document) {
  return normalizeDocumentName(document?.originalName)
    || normalizeDocumentName(document?.filename)
    || "";
}
