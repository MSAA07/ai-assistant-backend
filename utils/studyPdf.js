import PDFDocument from "pdfkit";

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
  summary: "Summary",
  flashcards: "Flashcards",
  exam: "Exam",
});

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeFileSegment(value, fallback = "document") {
  const normalized = normalizeString(value)
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .replace(/[^a-z0-9]+/gi, "-")
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
  doc
    .font("Helvetica-Bold")
    .fontSize(PDF_LAYOUT.titleFontSize)
    .fillColor("#111827")
    .text(documentTitle);

  doc.moveDown(0.35);

  doc
    .font("Helvetica")
    .fontSize(PDF_LAYOUT.smallFontSize)
    .fillColor("#6B7280")
    .text(`Study Hub export - ${featureLabel}`, { lineGap: 2 });

  doc
    .text(`Generated ${new Date().toLocaleString("en-US")}`, { lineGap: 2 });

  doc.moveDown(1.1);
}

function renderSectionHeading(doc, value) {
  wrapUp(doc);
  doc
    .font("Helvetica-Bold")
    .fontSize(PDF_LAYOUT.sectionFontSize)
    .fillColor("#111827")
    .text(value);
  doc.moveDown(0.45);
}

function renderParagraph(doc, value, options = {}) {
  const text = normalizeString(value);
  if (!text) {
    return;
  }

  wrapUp(doc);
  doc
    .font(options.bold ? "Helvetica-Bold" : "Helvetica")
    .fontSize(options.fontSize ?? PDF_LAYOUT.bodyFontSize)
    .fillColor(options.color ?? "#1F2937")
    .text(text, {
      lineGap: options.lineGap ?? PDF_LAYOUT.lineGap,
      indent: options.indent ?? 0,
    });
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
  const featureLabel = FEATURE_LABELS[feature] ?? "Study";
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
