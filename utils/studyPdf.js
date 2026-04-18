import path from "path";
import { fileURLToPath } from "url";

import PDFDocument from "pdfkit";

import { repairPotentialUnicodeCorruption } from "./filenames.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

const ARABIC_SCRIPT_PATTERN = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/u;
const FONT_FILES = Object.freeze({
  regular: path.join(__dirname, "..", "assets", "fonts", "NotoNaskhArabic-Regular.ttf"),
  bold: path.join(__dirname, "..", "assets", "fonts", "NotoNaskhArabic-Bold.ttf"),
});

function normalizeString(value) {
  if (typeof value !== "string") {
    return "";
  }

  return repairPotentialUnicodeCorruption(value).trim();
}

function hasArabicText(value) {
  return ARABIC_SCRIPT_PATTERN.test(normalizeString(value));
}

function documentUsesArabic(document) {
  return normalizeString(document?.language).toLowerCase() === "arabic"
    || hasArabicText(document?.originalName)
    || hasArabicText(document?.summary)
    || (Array.isArray(document?.flashcards) && document.flashcards.some((card) => hasArabicText(card?.question) || hasArabicText(card?.answer) || hasArabicText(card?.explanation)))
    || (Array.isArray(document?.examQuestions) && document.examQuestions.some((question) => hasArabicText(question?.question)));
}

function getFeatureLabel(feature, document) {
  const dictionary = documentUsesArabic(document) ? FEATURE_LABELS.arabic : FEATURE_LABELS.default;
  return dictionary[feature] ?? FEATURE_LABELS.default.summary;
}

function getTextOptions(value, options = {}) {
  const rtl = options.rtl ?? hasArabicText(value);
  return {
    lineGap: options.lineGap ?? PDF_LAYOUT.lineGap,
    indent: rtl ? 0 : (options.indent ?? 0),
    align: rtl ? "right" : (options.align ?? "left"),
    features: { liga: true, rlig: true },
  };
}

function applyTextFont(doc, value, options = {}) {
  const usesArabic = options.forceArabic || hasArabicText(value);
  if (usesArabic) {
    doc.font(options.bold ? FONT_FILES.bold : FONT_FILES.regular);
    return;
  }

  doc.font(options.bold ? "Helvetica-Bold" : "Helvetica");
}

function sanitizeFileSegment(value, fallback = "document") {
  const normalized = normalizeString(value)
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return normalized || fallback;
}

function wrapUp(doc) {
  if (doc.y > doc.page.height - PDF_LAYOUT.margin - 72) {
    doc.addPage();
  }
}

function renderMeta(doc, documentTitle, featureLabel) {
  applyTextFont(doc, documentTitle, { bold: true });
  doc
    .fontSize(PDF_LAYOUT.titleFontSize)
    .fillColor("#111827")
    .text(documentTitle, getTextOptions(documentTitle));

  doc.moveDown(0.35);

  applyTextFont(doc, featureLabel);
  doc
    .fontSize(PDF_LAYOUT.smallFontSize)
    .fillColor("#6B7280")
    .text(`Study Hub export - ${featureLabel}`, getTextOptions(featureLabel, { lineGap: 2 }));

  doc
    .font("Helvetica")
    .text(`Generated ${new Date().toLocaleString("en-US")}`, { lineGap: 2 });

  doc.moveDown(1.1);
}

function renderSectionHeading(doc, value) {
  wrapUp(doc);
  applyTextFont(doc, value, { bold: true });
  doc
    .fontSize(PDF_LAYOUT.sectionFontSize)
    .fillColor("#111827")
    .text(value, getTextOptions(value));
  doc.moveDown(0.45);
}

function renderParagraph(doc, value, options = {}) {
  const text = normalizeString(value);
  if (!text) {
    return;
  }

  wrapUp(doc);
  applyTextFont(doc, text, { bold: options.bold, forceArabic: options.forceArabic });
  doc
    .fontSize(options.fontSize ?? PDF_LAYOUT.bodyFontSize)
    .fillColor(options.color ?? "#1F2937")
    .text(text, getTextOptions(text, options));
  doc.moveDown(options.spacing ?? 0.7);
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
        renderParagraph(doc, `- ${item.replace(/^-\s+/, "")}`, { spacing: 0.35 });
      }
      doc.moveDown(0.35);
      continue;
    }

    renderParagraph(doc, block.replace(/\s*\n+\s*/g, " "));
  }
}

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
  const documentTitle = sanitizeFileSegment(document?.originalName || document?.title || document?.filename, "study-document");
  const featureLabel = sanitizeFileSegment(feature, "study");
  return `${featureLabel}-${documentTitle}.pdf`;
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
  const featureLabel = getFeatureLabel(feature, document) ?? "Study";
  const documentTitle = normalizeString(document?.originalName || document?.title || document?.filename) || "Study document";

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

  renderMeta(pdf, documentTitle, featureLabel);

  if (feature === "summary") {
    renderSectionHeading(pdf, featureLabel);
    renderSummary(pdf, document?.summary);
  } else if (feature === "flashcards") {
    renderSectionHeading(pdf, featureLabel);
    renderFlashcards(pdf, document?.flashcards);
  } else {
    renderSectionHeading(pdf, featureLabel);
    renderExam(pdf, document?.examQuestions);
  }

  pdf.end();
  return bufferPromise;
}
