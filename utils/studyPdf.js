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
  headerEyebrowFontSize: 10,
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
    summary: "\u0627\u0644\u0645\u0644\u062e\u0635",
    flashcards: "\u0627\u0644\u0628\u0637\u0627\u0642\u0627\u062a \u0627\u0644\u062a\u0639\u0644\u064a\u0645\u064a\u0629",
    exam: "\u0627\u0644\u0627\u062e\u062a\u0628\u0627\u0631",
  },
});

const EXPORT_COPY = Object.freeze({
  default: {
    headerEyebrow: "Study Hub export",
    generatedAt: "Generated",
    flashcardQuestion: "Q:",
    flashcardAnswer: "A:",
    flashcardExplanation: "Explanation:",
    examQuestion: "Question",
  },
  arabic: {
    headerEyebrow: "\u062a\u0635\u062f\u064a\u0631 \u062f\u0631\u0627\u0633\u064a",
    generatedAt: "\u062a\u0645 \u0627\u0644\u0625\u0646\u0634\u0627\u0621",
    flashcardQuestion: "\u0633:",
    flashcardAnswer: "\u062c:",
    flashcardExplanation: "\u0627\u0644\u062a\u0648\u0636\u064a\u062d:",
    examQuestion: "\u0627\u0644\u0633\u0624\u0627\u0644",
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
  return typeof value === "string"
    ? repairPotentialUnicodeCorruption(value).replace(/\r\n?/g, "\n").trim()
    : "";
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

function getLocaleKey(document) {
  return documentUsesArabic(document) ? "arabic" : "default";
}

function getFeatureLabel(feature, localeKey) {
  return FEATURE_LABELS[localeKey]?.[feature] ?? FEATURE_LABELS.default[feature] ?? "Study";
}

function getCopy(localeKey) {
  return EXPORT_COPY[localeKey] ?? EXPORT_COPY.default;
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

function wrapUp(doc, minBottomGap = 72) {
  if (doc.y > doc.page.height - PDF_LAYOUT.margin - minBottomGap) {
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

function drawDivider(doc) {
  const y = doc.y;
  doc
    .save()
    .lineWidth(1)
    .strokeColor("#E5E7EB")
    .moveTo(PDF_LAYOUT.margin, y)
    .lineTo(doc.page.width - PDF_LAYOUT.margin, y)
    .stroke()
    .restore();
  doc.moveDown(0.9);
}

function normalizeArabicPunctuation(text) {
  return text
    .replace(/(^|\s)\.(\d{4}\b)/g, "$1$2")
    .replace(/(\d(?:[.,]\d+)?)\s*و،\s*(\d(?:[.,]\d+)?)/g, "$1، و$2")
    .replace(/(\d(?:[.,]\d+)?)\s*،\s*و\s*(\d(?:[.,]\d+)?)/g, "$1، و$2")
    .replace(/\s+([،؛:.!?])/g, "$1")
    .replace(/([،؛])(?=\S)/g, "$1 ")
    .replace(/(?<=\d)\s*[–—-]\s*(?=\d)/gu, "–")
    .replace(/\s{2,}/g, " ");
}

function normalizeExportText(value, { rtl = false } = {}) {
  let text = normalizeString(value)
    .replace(/^[*_=-]{3,}$/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");

  if (rtl || containsArabic(text)) {
    text = normalizeArabicPunctuation(text);
  }

  return text.trim();
}

function normalizeMarkdownLine(value) {
  const text = normalizeExportText(value, { rtl: containsArabic(value) });
  const boldMatch = text.match(/^\*\*(.+?)\*\*$/);
  if (boldMatch) {
    return {
      text: normalizeExportText(boldMatch[1], { rtl: containsArabic(boldMatch[1]) }),
      bold: true,
    };
  }

  return {
    text: text.replace(/\*\*(.+?)\*\*/g, "$1"),
    bold: false,
  };
}

function formatTimestamp(localeKey) {
  const now = new Date();
  const locale = localeKey === "arabic" ? "ar-SA" : "en-US";
  const dateText = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(now);
  const timeText = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(now);

  return localeKey === "arabic"
    ? `${dateText}، ${timeText}`
    : `${dateText}, ${timeText}`;
}

function renderTextBlock(doc, value, options = {}) {
  const text = normalizeExportText(value, { rtl: options.direction === "rtl" || containsArabic(value) });
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

function renderMeta(doc, { documentTitle, featureLabel, localeKey }) {
  const copy = getCopy(localeKey);
  const timestampLine = localeKey === "arabic"
    ? `${copy.generatedAt}: ${formatTimestamp(localeKey)}`
    : `${copy.generatedAt} ${formatTimestamp(localeKey)}`;

  renderTextBlock(doc, copy.headerEyebrow, {
    bold: true,
    fontSize: PDF_LAYOUT.headerEyebrowFontSize,
    color: "#6B7280",
    lineGap: 2,
    spacing: 0.2,
    direction: localeKey === "arabic" ? "rtl" : "ltr",
  });

  renderTextBlock(doc, documentTitle, {
    bold: true,
    fontSize: PDF_LAYOUT.titleFontSize,
    color: "#111827",
    lineGap: 6,
    spacing: 0.2,
    direction: localeKey === "arabic" ? "rtl" : "ltr",
  });

  renderTextBlock(doc, timestampLine, {
    fontSize: PDF_LAYOUT.smallFontSize,
    color: "#6B7280",
    lineGap: 2,
    spacing: 0.5,
    direction: localeKey === "arabic" ? "rtl" : "ltr",
  });

  drawDivider(doc);
}

function renderSectionHeading(doc, value, options = {}) {
  wrapUp(doc);
  renderTextBlock(doc, value, {
    bold: true,
    fontSize: PDF_LAYOUT.sectionFontSize,
    color: "#111827",
    lineGap: 5,
    spacing: 0.45,
    direction: options.direction,
  });
}

function renderParagraph(doc, value, options = {}) {
  const text = normalizeExportText(value, { rtl: options.direction === "rtl" || containsArabic(value) });
  if (!text) {
    return;
  }

  wrapUp(doc);
  renderTextBlock(doc, text, options);
}

function renderBulletItem(doc, value, options = {}) {
  const normalized = normalizeMarkdownLine(value);
  if (!normalized.text) {
    return;
  }

  const bulletText = options.direction === "rtl"
    ? `${normalized.text} •`
    : `• ${normalized.text}`;

  renderParagraph(doc, bulletText, {
    ...options,
    bold: normalized.bold,
    spacing: options.spacing ?? 0.35,
  });
}

function classifySummaryBlocks(summary) {
  const lines = normalizeExportText(summary, { rtl: containsArabic(summary) })
    .split("\n")
    .map((line) => line.trim());
  const blocks = [];
  let paragraphBuffer = [];

  function flushParagraph() {
    if (paragraphBuffer.length === 0) {
      return;
    }

    const merged = paragraphBuffer.join(" ").trim();
    if (merged) {
      blocks.push({
        type: "paragraph",
        ...normalizeMarkdownLine(merged),
      });
    }
    paragraphBuffer = [];
  }

  for (const line of lines) {
    if (!line) {
      flushParagraph();
      continue;
    }

    if (/^#{1,6}\s+/.test(line)) {
      flushParagraph();
      blocks.push({
        type: "heading",
        text: normalizeExportText(line.replace(/^#{1,6}\s+/, ""), { rtl: containsArabic(line) }),
      });
      continue;
    }

    if (/^(?:[-*]\s+|\d+[.)]\s+)/.test(line)) {
      flushParagraph();
      blocks.push({
        type: "bullet",
        ...normalizeMarkdownLine(line.replace(/^(?:[-*]\s+|\d+[.)]\s+)/, "")),
      });
      continue;
    }

    paragraphBuffer.push(line);
  }

  flushParagraph();
  return blocks;
}

function renderSummary(doc, summary, options = {}) {
  const blocks = classifySummaryBlocks(summary);
  for (const block of blocks) {
    if (block.type === "heading") {
      renderSectionHeading(doc, block.text, options);
      continue;
    }

    if (block.type === "bullet") {
      renderBulletItem(doc, block.text, {
        ...options,
        bold: block.bold,
      });
      continue;
    }

    renderParagraph(doc, block.text, {
      ...options,
      bold: block.bold,
    });
  }
}

function renderFlashcards(doc, flashcards = [], options = {}) {
  const copy = getCopy(options.localeKey);
  flashcards.forEach((flashcard) => {
    renderParagraph(doc, `${copy.flashcardQuestion} ${normalizeExportText(flashcard?.question, options)}`, {
      bold: true,
      spacing: 0.3,
      ...options,
    });
    renderParagraph(doc, `${copy.flashcardAnswer} ${normalizeExportText(flashcard?.answer, options)}`, {
      spacing: 0.35,
      ...options,
    });

    const explanation = normalizeExportText(flashcard?.explanation, options);
    if (explanation) {
      renderParagraph(doc, `${copy.flashcardExplanation} ${explanation}`, {
        color: "#4B5563",
        spacing: 0.75,
        ...options,
      });
    }
  });
}

function renderExam(doc, questions = [], options = {}) {
  const copy = getCopy(options.localeKey);
  questions.forEach((question, index) => {
    renderSectionHeading(doc, `${copy.examQuestion} ${index + 1}`, options);
    renderParagraph(doc, normalizeExportText(question?.question, options), {
      bold: true,
      spacing: 0.35,
      ...options,
    });

    const optionValues = Array.isArray(question?.options) ? question.options : [];
    if (optionValues.length > 0) {
      optionValues.forEach((option, optionIndex) => {
        const optionLabel = String.fromCharCode(65 + optionIndex);
        renderBulletItem(doc, `${optionLabel}. ${normalizeExportText(option, options)}`, {
          spacing: 0.25,
          ...options,
        });
      });
      doc.moveDown(0.35);
    }
  });
}

export const __studyPdfTestables = Object.freeze({
  getTextDirection,
  normalizeExportText,
  toVisualPdfText,
  wrapLogicalText,
});

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
  const localeKey = getLocaleKey(document);
  const featureLabel = getFeatureLabel(feature, localeKey);
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
  renderMeta(pdf, {
    documentTitle,
    featureLabel,
    localeKey,
  });

  const sectionOptions = {
    localeKey,
    direction: localeKey === "arabic" ? "rtl" : "ltr",
  };

  if (feature === "summary") {
    renderSummary(pdf, document?.summary, sectionOptions);
  } else if (feature === "flashcards") {
    renderSectionHeading(pdf, featureLabel, sectionOptions);
    renderFlashcards(pdf, document?.flashcards, sectionOptions);
  } else {
    renderSectionHeading(pdf, featureLabel, sectionOptions);
    renderExam(pdf, document?.examQuestions, sectionOptions);
  }

  pdf.end();
  return bufferPromise;
}
