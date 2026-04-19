import bidiFactory from "bidi-js";
import PDFDocument from "pdfkit";
import path from "path";
import { fileURLToPath } from "url";

import {
  normalizeDocumentName,
  repairPotentialUnicodeCorruption,
} from "./filenames.js";

const bidi = bidiFactory();

const PDF_LAYOUT = Object.freeze({
  size: "A4",
  margin: 56,
  titleFontSize: 22,
  sectionFontSize: 16,
  bodyFontSize: 11,
  smallFontSize: 9,
  lineGap: 4,
});

const FEATURE_LABELS = Object.freeze({
  default: {
    summary: "Summary",
    flashcards: "Flashcards",
    exam: "Exam",
  },
  arabic: {
    summary: "الملخص",
    flashcards: "البطاقات التعليمية",
    exam: "الاختبار",
  },
});

const ARABIC_CHARS = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;
const LATIN_CHARS = /[A-Za-z]/;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PDF_FONT_ALIASES = Object.freeze({
  latin: "NotoSansLatin-Regular",
  latinBold: "NotoSansLatin-Bold",
  arabic: "NotoNaskhArabic-Regular",
  arabicBold: "NotoNaskhArabic-Bold",
});
const PDF_FONT_PATHS = Object.freeze({
  [PDF_FONT_ALIASES.latin]: path.join(__dirname, "..", "node_modules", "@fontsource", "noto-sans", "files", "noto-sans-latin-400-normal.woff"),
  [PDF_FONT_ALIASES.latinBold]: path.join(__dirname, "..", "node_modules", "@fontsource", "noto-sans", "files", "noto-sans-latin-700-normal.woff"),
  [PDF_FONT_ALIASES.arabic]: path.join(__dirname, "..", "assets", "fonts", "NotoNaskhArabic-Regular.ttf"),
  [PDF_FONT_ALIASES.arabicBold]: path.join(__dirname, "..", "assets", "fonts", "NotoNaskhArabic-Bold.ttf"),
});
const graphemeSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter("ar", { granularity: "grapheme" })
  : null;
const RESERVED_FILENAME_CHARS = /[<>:"/\\|?*]/g;
const TRAILING_WINDOWS_CHARS = /[. ]+$/g;

function normalizeString(value) {
  return typeof value === "string" ? repairPotentialUnicodeCorruption(value).trim() : "";
}

function sanitizeDownloadFilename(value, fallback = "document") {
  const normalizeFilename = (input) => normalizeString(input)
    .replace(RESERVED_FILENAME_CHARS, " ")
    .replace(/\s+/g, " ")
    .replace(TRAILING_WINDOWS_CHARS, "")
    .trim();

  const normalizedFallback = normalizeFilename(fallback) || "document";
  return normalizeFilename(value) || normalizedFallback;
}

function stripTrailingExtension(value) {
  return normalizeString(value).replace(/\.[a-z0-9]{1,10}$/i, "");
}

function containsArabic(value) {
  return ARABIC_CHARS.test(normalizeString(value));
}

function documentUsesArabic(document) {
  return normalizeString(document?.language).toLowerCase() === "arabic"
    || containsArabic(document?.originalName)
    || containsArabic(document?.summary)
    || (Array.isArray(document?.flashcards) && document.flashcards.some((card) => containsArabic(card?.question) || containsArabic(card?.answer) || containsArabic(card?.explanation)))
    || (Array.isArray(document?.examQuestions) && document.examQuestions.some((question) => containsArabic(question?.question)));
}

function getFeatureLabel(feature, document) {
  const dictionary = documentUsesArabic(document) ? FEATURE_LABELS.arabic : FEATURE_LABELS.default;
  return dictionary[feature] ?? FEATURE_LABELS.default.summary;
}

function getContentWidth(doc, inset = 0) {
  return doc.page.width - (PDF_LAYOUT.margin * 2) - inset;
}

function getTextDirection(value) {
  const normalized = normalizeString(value);

  for (const char of normalized) {
    if (ARABIC_CHARS.test(char)) {
      return "rtl";
    }
    if (LATIN_CHARS.test(char)) {
      return "ltr";
    }
  }

  return containsArabic(normalized) ? "rtl" : "ltr";
}

function reverseText(value) {
  if (!value) {
    return "";
  }

  if (!graphemeSegmenter) {
    return Array.from(value).reverse().join("");
  }

  return Array.from(graphemeSegmenter.segment(value), (segment) => segment.segment).reverse().join("");
}

function toVisualPdfText(value, direction = getTextDirection(value)) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return normalized;
  }

  if (!containsArabic(normalized)) {
    return normalized;
  }

  const embeddingLevels = bidi.getEmbeddingLevels(normalized, direction);
  const reordered = bidi.getReorderedString(normalized, embeddingLevels);
  return reordered.replace(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]+/g, (segment) => reverseText(segment));
}

function getCharFontBucket(char) {
  if (ARABIC_CHARS.test(char)) {
    return "arabic";
  }
  if (/\s/.test(char)) {
    return "space";
  }
  return "latin";
}

function splitVisualLineIntoFontRuns(value) {
  const chars = Array.from(value);
  if (chars.length === 0) {
    return [];
  }

  const segments = [];
  let currentBucket = getCharFontBucket(chars[0]);
  let currentText = chars[0];

  for (let index = 1; index < chars.length; index += 1) {
    const char = chars[index];
    const bucket = getCharFontBucket(char);

    if (bucket === currentBucket) {
      currentText += char;
      continue;
    }

    segments.push({ bucket: currentBucket, text: currentText });
    currentBucket = bucket;
    currentText = char;
  }

  segments.push({ bucket: currentBucket, text: currentText });
  return segments;
}

function measureLogicalTextWidth(doc, value, direction, options = {}) {
  const visualLine = toVisualPdfText(value, direction);
  const segments = splitVisualLineIntoFontRuns(visualLine);

  return segments.reduce((total, segment) => {
    applyFont(doc, segment.bucket === "arabic" ? "العربية" : segment.text, { bold: options.bold });
    return total + doc.widthOfString(segment.text);
  }, 0);
}

function splitOversizedToken(doc, token, maxWidth, direction) {
  const chars = Array.from(token);
  const segments = [];
  let current = "";

  chars.forEach((char) => {
    const candidate = current + char;
    if (current && measureLogicalTextWidth(doc, candidate, direction) > maxWidth) {
      segments.push(current);
      current = char;
      return;
    }
    current = candidate;
  });

  if (current) {
    segments.push(current);
  }

  return segments.length > 0 ? segments : [token];
}

function wrapLogicalText(doc, value, width, direction) {
  const normalized = normalizeString(value).replace(/\s+/g, " ");
  if (!normalized) {
    return [];
  }

  const tokens = normalized.split(" ");
  const lines = [];
  let current = "";

  const pushToken = (token) => {
    const candidate = current ? `${current} ${token}` : token;
    if (!current || measureLogicalTextWidth(doc, candidate, direction) <= width) {
      current = candidate;
      return;
    }

    lines.push(current);

    if (measureLogicalTextWidth(doc, token, direction) <= width) {
      current = token;
      return;
    }

    const segments = splitOversizedToken(doc, token, width, direction);
    lines.push(...segments.slice(0, -1));
    current = segments[segments.length - 1] ?? "";
  };

  tokens.forEach(pushToken);

  if (current) {
    lines.push(current);
  }

  return lines;
}

function resolveFontName(value, { bold = false } = {}) {
  if (!containsArabic(value)) {
    return bold ? PDF_FONT_ALIASES.latinBold : PDF_FONT_ALIASES.latin;
  }

  return bold ? PDF_FONT_ALIASES.arabicBold : PDF_FONT_ALIASES.arabic;
}

function applyFont(doc, value, options = {}) {
  doc.font(resolveFontName(value, options));
}

function drawVisualLine(doc, visualLine, x, y, options = {}) {
  const segments = splitVisualLineIntoFontRuns(visualLine);
  let cursorX = x;

  segments.forEach((segment) => {
    applyFont(doc, segment.bucket === "arabic" ? "العربية" : segment.text, { bold: options.bold });
    doc.text(segment.text, cursorX, y, { lineBreak: false });
    cursorX += doc.widthOfString(segment.text);
  });
}

function registerPdfFonts(doc) {
  doc.registerFont(PDF_FONT_ALIASES.latin, PDF_FONT_PATHS[PDF_FONT_ALIASES.latin]);
  doc.registerFont(PDF_FONT_ALIASES.latinBold, PDF_FONT_PATHS[PDF_FONT_ALIASES.latinBold]);
  doc.registerFont(PDF_FONT_ALIASES.arabic, PDF_FONT_PATHS[PDF_FONT_ALIASES.arabic]);
  doc.registerFont(PDF_FONT_ALIASES.arabicBold, PDF_FONT_PATHS[PDF_FONT_ALIASES.arabicBold]);
}

function wrapUp(doc) {
  if (doc.y > doc.page.height - PDF_LAYOUT.margin - 72) {
    doc.addPage();
  }
}

function ensureVerticalSpace(doc, height) {
  if (doc.y + height > doc.page.height - PDF_LAYOUT.margin) {
    doc.addPage();
  }
}

function getLineAdvance(doc, lineGap) {
  return doc.currentLineHeight(true) + lineGap;
}

function renderTextBlock(doc, value, options = {}) {
  const text = normalizeString(value);
  if (!text) {
    return;
  }

  const direction = options.direction ?? getTextDirection(text);
  const fontSize = options.fontSize ?? PDF_LAYOUT.bodyFontSize;
  const lineGap = options.lineGap ?? PDF_LAYOUT.lineGap;
  const inset = options.indent ?? 0;
  const width = getContentWidth(doc, inset);

  applyFont(doc, text, { bold: options.bold });
  doc
    .fontSize(fontSize)
    .fillColor(options.color ?? "#1F2937");

  const lines = wrapLogicalText(doc, text, width, direction);
  const lineAdvance = getLineAdvance(doc, lineGap);

  lines.forEach((line) => {
    ensureVerticalSpace(doc, lineAdvance);

    const visualLine = toVisualPdfText(line, direction);
    const lineWidth = Math.min(measureLogicalTextWidth(doc, line, direction, { bold: options.bold }), width);
    const x = direction === "rtl"
      ? doc.page.width - PDF_LAYOUT.margin - inset - lineWidth
      : PDF_LAYOUT.margin + inset;

    drawVisualLine(doc, visualLine, x, doc.y, { bold: options.bold });

    doc.y += lineAdvance;
  });

  doc.y += (options.spacing ?? 0.7) * doc.currentLineHeight(true);
}

function renderMeta(doc, documentTitle, featureLabel) {
  renderTextBlock(doc, documentTitle, {
    bold: true,
    fontSize: PDF_LAYOUT.titleFontSize,
    color: "#111827",
    lineGap: 6,
    spacing: 0.25,
  });

  applyFont(doc, featureLabel);
  doc
    .fontSize(PDF_LAYOUT.smallFontSize)
    .fillColor("#6B7280")
    .text(`Study Hub export - ${featureLabel}`, { lineGap: 2 });

  doc
    .text(`Generated ${new Date().toLocaleString("en-US")}`, { lineGap: 2 });

  doc.moveDown(1.1);
}

function renderSectionHeading(doc, value) {
  wrapUp(doc);
  renderTextBlock(doc, value, {
    bold: true,
    fontSize: PDF_LAYOUT.sectionFontSize,
    color: "#111827",
    lineGap: 5,
    spacing: 0.45,
  });
}

function renderParagraph(doc, value, options = {}) {
  const text = normalizeString(value);
  if (!text) {
    return;
  }

  wrapUp(doc);
  renderTextBlock(doc, text, options);
}

function renderSummary(doc, summary) {
  const blocks = normalizeString(summary)
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  for (const block of blocks) {
    if (/^##\s+/.test(block)) {
      renderSectionHeading(doc, block.replace(/^##\s+/, ""));
      continue;
    }

    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length > 0 && lines.every((line) => /^-\s+/.test(line))) {
      for (const item of lines) {
        renderParagraph(doc, `• ${item.replace(/^-\s+/, "")}`, { spacing: 0.35 });
      }
      doc.moveDown(0.35);
      continue;
    }

    renderParagraph(doc, block.replace(/\s*\n+\s*/g, " "));
  }
}

export const __studyPdfTestables = Object.freeze({
  getTextDirection,
  toVisualPdfText,
  wrapLogicalText,
});

function renderFlashcards(doc, flashcards = []) {
  flashcards.forEach((flashcard) => {
    renderParagraph(doc, `Q: ${normalizeString(flashcard?.question)}`, { bold: true, spacing: 0.3 });
    renderParagraph(doc, `A: ${normalizeString(flashcard?.answer)}`, { spacing: 0.35 });

    const explanation = normalizeString(flashcard?.explanation);
    if (explanation) {
      renderParagraph(doc, `Explanation: ${explanation}`, { color: "#4B5563", spacing: 0.75 });
    }
  });
}

function renderExam(doc, questions = []) {
  questions.forEach((question, index) => {
    renderSectionHeading(doc, `Question ${index + 1}`);
    renderParagraph(doc, normalizeString(question?.question), { bold: true, spacing: 0.35 });

    const options = Array.isArray(question?.options) ? question.options : [];
    if (options.length > 0) {
      options.forEach((option, optionIndex) => {
        const optionLabel = String.fromCharCode(65 + optionIndex);
        renderParagraph(doc, `${optionLabel}. ${normalizeString(option)}`, { spacing: 0.25, indent: 12 });
      });
      doc.moveDown(0.4);
    }
  });
}

export function normalizeStudyExportFeature(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === "summary" || normalized === "flashcards" || normalized === "exam") {
    return normalized;
  }
  return "";
}

export function buildStudyPdfFileName(document, feature) {
  const baseName = sanitizeDownloadFilename(
    stripTrailingExtension(normalizeDocumentName(document?.originalName || document?.title || document?.filename)),
    "study-document",
  );
  const featureLabel = sanitizeDownloadFilename(feature, "study");
  return sanitizeDownloadFilename(`${featureLabel}-${baseName}.pdf`, `${featureLabel}-study-document.pdf`);
}

export function hasStudyExportContent(document, feature) {
  if (feature === "summary") {
    return Boolean(normalizeString(document?.summary));
  }
  if (feature === "flashcards") {
    return Array.isArray(document?.flashcards) && document.flashcards.length > 0;
  }
  if (feature === "exam") {
    return Array.isArray(document?.examQuestions) && document.examQuestions.length > 0;
  }
  return false;
}

export async function buildStudyPdfBuffer(document, feature) {
  const featureLabel = getFeatureLabel(feature, document);
  const documentTitle = stripTrailingExtension(
    normalizeDocumentName(document?.originalName || document?.title || document?.filename),
  ) || "Study document";

  const pdf = new PDFDocument({
    size: PDF_LAYOUT.size,
    margin: PDF_LAYOUT.margin,
    info: {
      Title: `${documentTitle} - ${featureLabel}`,
      Author: "AI Study Assistant",
      Subject: `${featureLabel} export`,
      Creator: "AI Study Assistant",
      Producer: "AI Study Assistant",
    },
  });

  const chunks = [];
  const bufferPromise = new Promise((resolve, reject) => {
    pdf.on("data", (chunk) => chunks.push(chunk));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });

  registerPdfFonts(pdf);
  renderMeta(pdf, documentTitle, featureLabel);

  if (feature === "summary") {
    renderSectionHeading(pdf, "Summary");
    renderSummary(pdf, document?.summary);
  } else if (feature === "flashcards") {
    renderSectionHeading(pdf, "Flashcards");
    renderFlashcards(pdf, document?.flashcards);
  } else {
    renderSectionHeading(pdf, "Exam");
    renderExam(pdf, document?.examQuestions);
  }

  pdf.end();
  return bufferPromise;
}
