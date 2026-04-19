import bidiFactory from "bidi-js";
import PDFDocument from "pdfkit";
import path from "path";
import { fileURLToPath } from "url";

import { normalizeDocumentName, sanitizeDownloadFilename } from "./filenames.js";

const bidi = bidiFactory();

const SPACING = Object.freeze({
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 40,
});

const PDF_LAYOUT = Object.freeze({
  size: "A4",
  margins: {
    top: 40,
    bottom: 40,
    left: 48,
    right: 48,
  },
  maxContentWidth: 468,
  radius: 10,
  cardPadding: 16,
  titleFontSize: 24,
  sectionFontSize: 18,
  subsectionFontSize: 14,
  bodyFontSize: 11,
  labelFontSize: 9,
  metaFontSize: 10,
  lineHeight: 1.6,
  lineGap: 6,
  paragraphGap: SPACING.md,
  sectionGap: SPACING.xl,
  blockGap: SPACING.lg,
});

const COLORS = Object.freeze({
  text: "#111827",
  muted: "#4B5563",
  subtle: "#6B7280",
  border: "#D7DEEA",
  softBorder: "#E5EAF3",
  panel: "#F8FAFC",
  accentPanel: "#F4F7FB",
});

const FEATURE_LABELS = Object.freeze({
  summary: "Summary",
  flashcards: "Flashcards",
  exam: "Exam",
});

const SUMMARY_SECTION_ORDER = Object.freeze([
  "Key Themes",
  "Assessment Areas",
  "Interview Structure",
]);

const ARABIC_CHARS = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;
const LATIN_CHARS = /[A-Za-z]/;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PDF_FONT_ALIASES = Object.freeze({
  latin: "NotoSansLatin-Regular",
  latinBold: "NotoSansLatin-Bold",
  arabic: "NotoSansArabic-Regular",
  arabicBold: "NotoSansArabic-Bold",
});
const PDF_FONT_PATHS = Object.freeze({
  [PDF_FONT_ALIASES.latin]: path.join(__dirname, "..", "node_modules", "@fontsource", "noto-sans", "files", "noto-sans-latin-400-normal.woff"),
  [PDF_FONT_ALIASES.latinBold]: path.join(__dirname, "..", "node_modules", "@fontsource", "noto-sans", "files", "noto-sans-latin-700-normal.woff"),
  [PDF_FONT_ALIASES.arabic]: path.join(__dirname, "..", "assets", "fonts", "NotoSansArabic-Regular.ttf"),
  [PDF_FONT_ALIASES.arabicBold]: path.join(__dirname, "..", "assets", "fonts", "NotoSansArabic-Bold.ttf"),
});
const graphemeSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter("ar", { granularity: "grapheme" })
  : null;

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stripTrailingExtension(value) {
  return normalizeString(value).replace(/\.[a-z0-9]{1,10}$/i, "");
}

function containsArabic(value) {
  return ARABIC_CHARS.test(normalizeString(value));
}

function getPageInnerWidth(doc) {
  return doc.page.width - PDF_LAYOUT.margins.left - PDF_LAYOUT.margins.right;
}

function getContentMetrics(doc) {
  const pageInnerWidth = getPageInnerWidth(doc);
  const width = Math.min(PDF_LAYOUT.maxContentWidth, pageInnerWidth);
  const x = PDF_LAYOUT.margins.left + Math.max(0, (pageInnerWidth - width) / 2);
  return { x, width };
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

function resolveFontName(value, { bold = false } = {}) {
  if (!containsArabic(value)) {
    return bold ? PDF_FONT_ALIASES.latinBold : PDF_FONT_ALIASES.latin;
  }

  return bold ? PDF_FONT_ALIASES.arabicBold : PDF_FONT_ALIASES.arabic;
}

function applyFont(doc, value, options = {}) {
  doc.font(resolveFontName(value, options));
}

function registerPdfFonts(doc) {
  doc.registerFont(PDF_FONT_ALIASES.latin, PDF_FONT_PATHS[PDF_FONT_ALIASES.latin]);
  doc.registerFont(PDF_FONT_ALIASES.latinBold, PDF_FONT_PATHS[PDF_FONT_ALIASES.latinBold]);
  doc.registerFont(PDF_FONT_ALIASES.arabic, PDF_FONT_PATHS[PDF_FONT_ALIASES.arabic]);
  doc.registerFont(PDF_FONT_ALIASES.arabicBold, PDF_FONT_PATHS[PDF_FONT_ALIASES.arabicBold]);
}

function ensureVerticalSpace(doc, height) {
  if (doc.y + height > doc.page.height - PDF_LAYOUT.margins.bottom) {
    doc.addPage();
    doc.y = PDF_LAYOUT.margins.top;
  }
}

function getLineAdvance(doc, lineGap) {
  return doc.currentLineHeight(true) + lineGap;
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

function drawVisualLine(doc, visualLine, x, y, options = {}) {
  const segments = splitVisualLineIntoFontRuns(visualLine);
  let cursorX = x;

  segments.forEach((segment) => {
    applyFont(doc, segment.bucket === "arabic" ? "العربية" : segment.text, { bold: options.bold });
    doc.text(segment.text, cursorX, y, { lineBreak: false });
    cursorX += doc.widthOfString(segment.text);
  });
}

function getLineMetrics(doc, value, options = {}) {
  const direction = options.direction ?? getTextDirection(value);
  const fontSize = options.fontSize ?? PDF_LAYOUT.bodyFontSize;
  const lineGap = options.lineGap ?? PDF_LAYOUT.lineGap;

  applyFont(doc, value, { bold: options.bold });
  doc.fontSize(fontSize);

  const lines = wrapLogicalText(doc, value, options.width, direction);
  const lineAdvance = getLineAdvance(doc, lineGap);

  return {
    direction,
    lines,
    lineAdvance,
    height: lines.length * lineAdvance,
  };
}

function drawWrappedText(doc, value, options = {}) {
  const text = normalizeString(value);
  if (!text) {
    return 0;
  }

  const { x: contentX, width: contentWidth } = getContentMetrics(doc);
  const width = options.width ?? contentWidth;
  const x = options.x ?? contentX;
  const y = options.y ?? doc.y;
  const direction = options.direction ?? getTextDirection(text);
  const fontSize = options.fontSize ?? PDF_LAYOUT.bodyFontSize;
  const lineGap = options.lineGap ?? PDF_LAYOUT.lineGap;
  const color = options.color ?? COLORS.text;

  applyFont(doc, text, { bold: options.bold });
  doc.fontSize(fontSize).fillColor(color);

  const lines = wrapLogicalText(doc, text, width, direction);
  const lineAdvance = getLineAdvance(doc, lineGap);
  let cursorY = y;

  lines.forEach((line) => {
    const lineWidth = Math.min(measureLogicalTextWidth(doc, line, direction, { bold: options.bold }), width);
    const lineX = direction === "rtl" ? x + width - lineWidth : x;
    drawVisualLine(doc, toVisualPdfText(line, direction), lineX, cursorY, { bold: options.bold });
    cursorY += lineAdvance;
  });

  if (options.advanceCursor !== false) {
    doc.y = cursorY;
  }

  return cursorY - y;
}

function drawDivider(doc, spacingBefore = SPACING.lg, spacingAfter = SPACING.lg) {
  const { x, width } = getContentMetrics(doc);
  ensureVerticalSpace(doc, spacingBefore + 1 + spacingAfter);
  doc.y += spacingBefore;
  doc
    .save()
    .lineWidth(1)
    .strokeColor(COLORS.softBorder)
    .moveTo(x, doc.y)
    .lineTo(x + width, doc.y)
    .stroke()
    .restore();
  doc.y += spacingAfter;
}

function renderDocumentHeader(doc, documentTitle, featureLabel) {
  const { x, width } = getContentMetrics(doc);
  const headerTitleHeight = getLineMetrics(doc, documentTitle, {
    width,
    bold: true,
    fontSize: PDF_LAYOUT.titleFontSize,
    lineGap: 8,
  }).height;
  const headerMeta = `Study Hub export • ${featureLabel}`;
  const generatedAt = `Generated ${new Date().toLocaleString("en-US")}`;
  const metaHeight = getLineMetrics(doc, headerMeta, {
    width,
    fontSize: PDF_LAYOUT.metaFontSize,
    lineGap: 3,
  }).height + getLineMetrics(doc, generatedAt, {
    width,
    fontSize: PDF_LAYOUT.metaFontSize,
    lineGap: 3,
  }).height;
  const blockHeight = headerTitleHeight + SPACING.md + metaHeight + SPACING.xl;

  ensureVerticalSpace(doc, blockHeight);
  drawWrappedText(doc, documentTitle, {
    x,
    width,
    bold: true,
    fontSize: PDF_LAYOUT.titleFontSize,
    lineGap: 8,
    color: COLORS.text,
  });
  doc.y += SPACING.md;
  drawWrappedText(doc, headerMeta, {
    x,
    width,
    fontSize: PDF_LAYOUT.metaFontSize,
    lineGap: 3,
    color: COLORS.subtle,
  });
  drawWrappedText(doc, generatedAt, {
    x,
    width,
    fontSize: PDF_LAYOUT.metaFontSize,
    lineGap: 3,
    color: COLORS.subtle,
  });
  drawDivider(doc, SPACING.md, SPACING.xl);
}

function renderSectionTitle(doc, value) {
  const { x, width } = getContentMetrics(doc);
  const height = getLineMetrics(doc, value, {
    width,
    bold: true,
    fontSize: PDF_LAYOUT.sectionFontSize,
    lineGap: 6,
  }).height + SPACING.md;

  ensureVerticalSpace(doc, height);
  drawWrappedText(doc, value, {
    x,
    width,
    bold: true,
    fontSize: PDF_LAYOUT.sectionFontSize,
    lineGap: 6,
    color: COLORS.text,
  });
  doc.y += SPACING.md;
}

function renderSubsectionTitle(doc, value) {
  const { x, width } = getContentMetrics(doc);
  const height = getLineMetrics(doc, value, {
    width,
    bold: true,
    fontSize: PDF_LAYOUT.subsectionFontSize,
    lineGap: 5,
  }).height + SPACING.sm;

  ensureVerticalSpace(doc, height);
  drawWrappedText(doc, value, {
    x,
    width,
    bold: true,
    fontSize: PDF_LAYOUT.subsectionFontSize,
    lineGap: 5,
    color: COLORS.text,
  });
  doc.y += SPACING.sm;
}

function renderBodyParagraph(doc, value, options = {}) {
  const { x, width } = getContentMetrics(doc);
  const height = getLineMetrics(doc, value, {
    width: options.width ?? width,
    bold: options.bold,
    fontSize: options.fontSize ?? PDF_LAYOUT.bodyFontSize,
    lineGap: options.lineGap ?? PDF_LAYOUT.lineGap,
    direction: options.direction,
  }).height + (options.spacingAfter ?? PDF_LAYOUT.paragraphGap);

  ensureVerticalSpace(doc, height);
  drawWrappedText(doc, value, {
    x: options.x ?? x,
    width: options.width ?? width,
    bold: options.bold,
    fontSize: options.fontSize ?? PDF_LAYOUT.bodyFontSize,
    lineGap: options.lineGap ?? PDF_LAYOUT.lineGap,
    color: options.color ?? COLORS.text,
    direction: options.direction,
  });
  doc.y += options.spacingAfter ?? PDF_LAYOUT.paragraphGap;
}

function normalizeBulletText(value) {
  return normalizeString(value)
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+[.)]\s+/, "");
}

function splitSentenceGroups(text) {
  return normalizeString(text)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseSummaryBlocks(summary) {
  const source = normalizeString(summary);
  if (!source) {
    return [];
  }

  const rawBlocks = source
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  const blocks = [];

  rawBlocks.forEach((block) => {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 1 && /^##\s+/.test(lines[0])) {
      blocks.push({ type: "heading", text: lines[0].replace(/^##\s+/, "").trim() });
      return;
    }

    const bulletItems = [];
    const proseLines = [];

    lines.forEach((line) => {
      if (/^[-*•]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) {
        bulletItems.push(normalizeBulletText(line));
      } else {
        proseLines.push(line);
      }
    });

    if (bulletItems.length > 0 && proseLines.length === 0) {
      blocks.push({ type: "list", items: bulletItems });
      return;
    }

    const normalizedParagraph = proseLines.join(" ").replace(/\s+/g, " ").trim();
    if (!normalizedParagraph) {
      if (bulletItems.length > 0) {
        blocks.push({ type: "list", items: bulletItems });
      }
      return;
    }

    const inlineListParts = normalizedParagraph.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
    if (inlineListParts.length >= 3) {
      blocks.push({ type: "list", items: inlineListParts });
      return;
    }

    splitSentenceGroups(normalizedParagraph).forEach((sentence) => {
      blocks.push({ type: "paragraph", text: sentence });
    });

    if (bulletItems.length > 0) {
      blocks.push({ type: "list", items: bulletItems });
    }
  });

  return blocks;
}

function classifySummarySection(title = "", text = "") {
  const haystack = `${normalizeString(title)} ${normalizeString(text)}`.toLowerCase();

  if (/(interview|conversation|discussion|format|flow|opening|closing|structure)/.test(haystack)) {
    return "Interview Structure";
  }
  if (/(assessment|evaluation|criteria|competenc|skill|strength|weakness|question area|screening)/.test(haystack)) {
    return "Assessment Areas";
  }

  return "Key Themes";
}

function buildSummarySections(summary) {
  const parsedBlocks = parseSummaryBlocks(summary);
  const sections = new Map(SUMMARY_SECTION_ORDER.map((title) => [title, []]));
  let currentSection = "Key Themes";

  parsedBlocks.forEach((block) => {
    if (block.type === "heading") {
      currentSection = classifySummarySection(block.text, block.text);
      return;
    }

    const sampleText = block.type === "list" ? block.items.join(" ") : block.text;
    const targetSection = currentSection || classifySummarySection("", sampleText);
    sections.get(targetSection).push(block);
  });

  const assignedCount = SUMMARY_SECTION_ORDER.reduce((total, title) => total + sections.get(title).length, 0);
  if (assignedCount === 0) {
    return SUMMARY_SECTION_ORDER.map((title) => ({ title, blocks: [] }));
  }

  const nonEmpty = SUMMARY_SECTION_ORDER.filter((title) => sections.get(title).length > 0);
  if (nonEmpty.length === 1) {
    const [sourceTitle] = nonEmpty;
    const sourceBlocks = sections.get(sourceTitle);
    const bucketed = SUMMARY_SECTION_ORDER.map((title) => ({ title, blocks: [] }));

    sourceBlocks.forEach((block, index) => {
      const bucketIndex = Math.min(index, SUMMARY_SECTION_ORDER.length - 1);
      bucketed[bucketIndex].blocks.push(block);
    });

    return bucketed;
  }

  return SUMMARY_SECTION_ORDER.map((title) => ({ title, blocks: sections.get(title) }));
}

function renderBulletList(doc, items, options = {}) {
  const { x, width } = getContentMetrics(doc);
  const indent = options.indent ?? 18;
  const markerGap = options.markerGap ?? 10;
  const marker = options.marker ?? "•";
  const contentWidth = width - indent;

  items.forEach((item) => {
    const bulletText = normalizeString(item);
    if (!bulletText) {
      return;
    }

    const lineMetrics = getLineMetrics(doc, bulletText, {
      width: contentWidth - markerGap,
      fontSize: options.fontSize ?? PDF_LAYOUT.bodyFontSize,
      lineGap: options.lineGap ?? PDF_LAYOUT.lineGap,
      direction: options.direction,
    });
    const blockHeight = Math.max(lineMetrics.height, 12) + (options.itemGap ?? SPACING.sm);

    ensureVerticalSpace(doc, blockHeight);
    drawWrappedText(doc, marker, {
      x,
      y: doc.y,
      width: indent,
      fontSize: PDF_LAYOUT.labelFontSize,
      bold: true,
      lineGap: 2,
      color: COLORS.text,
      advanceCursor: false,
    });
    drawWrappedText(doc, bulletText, {
      x: x + indent,
      y: doc.y,
      width: contentWidth - markerGap,
      fontSize: options.fontSize ?? PDF_LAYOUT.bodyFontSize,
      lineGap: options.lineGap ?? PDF_LAYOUT.lineGap,
      color: options.color ?? COLORS.text,
      direction: options.direction,
      advanceCursor: false,
    });
    doc.y += blockHeight;
  });
}

function measureCardHeight(doc, segments, width) {
  let total = PDF_LAYOUT.cardPadding * 2;

  segments.forEach((segment, index) => {
    const metrics = getLineMetrics(doc, segment.text, {
      width,
      bold: segment.bold,
      fontSize: segment.fontSize,
      lineGap: segment.lineGap,
      direction: segment.direction,
    });
    total += metrics.height;

    if (segment.spacingAfter) {
      total += segment.spacingAfter;
    }

    if (index < segments.length - 1) {
      total += segment.gapAfter ?? 0;
    }
  });

  return total;
}

function renderCard(doc, segments, options = {}) {
  const { x, width } = getContentMetrics(doc);
  const cardWidth = options.width ?? width;
  const cardX = options.x ?? x;
  const contentX = cardX + PDF_LAYOUT.cardPadding;
  const contentWidth = cardWidth - (PDF_LAYOUT.cardPadding * 2);
  const cardHeight = measureCardHeight(doc, segments, contentWidth);

  ensureVerticalSpace(doc, cardHeight);

  doc
    .save()
    .roundedRect(cardX, doc.y, cardWidth, cardHeight, PDF_LAYOUT.radius)
    .fillAndStroke(options.fillColor ?? COLORS.panel, options.strokeColor ?? COLORS.border)
    .restore();

  let cursorY = doc.y + PDF_LAYOUT.cardPadding;

  segments.forEach((segment, index) => {
    const drawnHeight = drawWrappedText(doc, segment.text, {
      x: contentX,
      y: cursorY,
      width: contentWidth,
      fontSize: segment.fontSize,
      lineGap: segment.lineGap,
      bold: segment.bold,
      color: segment.color,
      direction: segment.direction,
      advanceCursor: false,
    });
    cursorY += drawnHeight;

    if (segment.spacingAfter) {
      cursorY += segment.spacingAfter;
    }

    if (index < segments.length - 1 && segment.gapAfter) {
      cursorY += segment.gapAfter;
    }
  });

  doc.y += cardHeight + (options.spacingAfter ?? PDF_LAYOUT.blockGap);
}

function renderSummary(doc, summary) {
  const sections = buildSummarySections(summary);

  sections.forEach((section, sectionIndex) => {
    renderSubsectionTitle(doc, section.title);

    if (section.blocks.length === 0) {
      renderBodyParagraph(doc, "No content was available for this section.", {
        color: COLORS.muted,
      });
    } else {
      section.blocks.forEach((block) => {
        if (block.type === "list") {
          renderBulletList(doc, block.items, { itemGap: SPACING.sm });
          doc.y += SPACING.sm;
          return;
        }

        renderBodyParagraph(doc, block.text, {
          spacingAfter: PDF_LAYOUT.paragraphGap,
        });
      });
    }

    if (sectionIndex < sections.length - 1) {
      doc.y += SPACING.sm;
    }
  });
}

export const __studyPdfTestables = Object.freeze({
  getTextDirection,
  toVisualPdfText,
  wrapLogicalText,
  parseSummaryBlocks,
  buildSummarySections,
});

function renderFlashcards(doc, flashcards = []) {
  flashcards.forEach((flashcard, index) => {
    const segments = [
      {
        text: "Question",
        bold: true,
        fontSize: PDF_LAYOUT.labelFontSize,
        lineGap: 2,
        color: COLORS.subtle,
        spacingAfter: SPACING.xs,
      },
      {
        text: normalizeString(flashcard?.question) || "No question provided.",
        bold: true,
        fontSize: PDF_LAYOUT.subsectionFontSize,
        lineGap: 5,
        color: COLORS.text,
        spacingAfter: SPACING.md,
      },
      {
        text: "Answer",
        bold: true,
        fontSize: PDF_LAYOUT.labelFontSize,
        lineGap: 2,
        color: COLORS.subtle,
        spacingAfter: SPACING.xs,
      },
      {
        text: normalizeString(flashcard?.answer) || "No answer provided.",
        fontSize: PDF_LAYOUT.bodyFontSize,
        lineGap: PDF_LAYOUT.lineGap,
        color: COLORS.text,
        spacingAfter: 0,
      },
    ];

    const explanation = normalizeString(flashcard?.explanation);
    if (explanation) {
      segments.push({
        text: "Explanation",
        bold: true,
        fontSize: PDF_LAYOUT.labelFontSize,
        lineGap: 2,
        color: COLORS.subtle,
        spacingAfter: SPACING.xs,
        gapAfter: SPACING.md,
      });
      segments.push({
        text: explanation,
        fontSize: PDF_LAYOUT.bodyFontSize,
        lineGap: PDF_LAYOUT.lineGap,
        color: COLORS.muted,
        spacingAfter: 0,
      });
    }

    renderCard(doc, segments, {
      fillColor: index % 2 === 0 ? COLORS.panel : COLORS.accentPanel,
      strokeColor: COLORS.softBorder,
      spacingAfter: SPACING.xl,
    });
  });
}

function renderExam(doc, questions = []) {
  questions.forEach((question, index) => {
    const questionSegments = [
      {
        text: `Question ${index + 1}`,
        bold: true,
        fontSize: PDF_LAYOUT.labelFontSize,
        lineGap: 2,
        color: COLORS.subtle,
        spacingAfter: SPACING.xs,
      },
      {
        text: normalizeString(question?.question) || "No question provided.",
        bold: true,
        fontSize: PDF_LAYOUT.subsectionFontSize,
        lineGap: 5,
        color: COLORS.text,
        spacingAfter: SPACING.md,
      },
    ];

    const { x, width } = getContentMetrics(doc);
    const cardWidth = width;
    const cardX = x;
    const contentX = cardX + PDF_LAYOUT.cardPadding;
    const contentWidth = cardWidth - (PDF_LAYOUT.cardPadding * 2);

    let cardHeight = measureCardHeight(doc, questionSegments, contentWidth);
    const options = Array.isArray(question?.options) ? question.options : [];

    if (options.length > 0) {
      cardHeight += SPACING.xs;
      options.forEach((option) => {
        const optionMetrics = getLineMetrics(doc, normalizeString(option), {
          width: contentWidth - 24,
          fontSize: PDF_LAYOUT.bodyFontSize,
          lineGap: PDF_LAYOUT.lineGap,
        });
        cardHeight += Math.max(optionMetrics.height, 12) + SPACING.sm;
      });
    }

    ensureVerticalSpace(doc, cardHeight + SPACING.xl);

    doc
      .save()
      .roundedRect(cardX, doc.y, cardWidth, cardHeight, PDF_LAYOUT.radius)
      .fillAndStroke(COLORS.panel, COLORS.border)
      .restore();

    let cursorY = doc.y + PDF_LAYOUT.cardPadding;
    questionSegments.forEach((segment) => {
      const drawnHeight = drawWrappedText(doc, segment.text, {
        x: contentX,
        y: cursorY,
        width: contentWidth,
        fontSize: segment.fontSize,
        lineGap: segment.lineGap,
        bold: segment.bold,
        color: segment.color,
        advanceCursor: false,
      });
      cursorY += drawnHeight + (segment.spacingAfter ?? 0);
    });

    if (options.length > 0) {
      cursorY += SPACING.xs;
    }

    options.forEach((option, optionIndex) => {
      const label = `${String.fromCharCode(65 + optionIndex)}.`;
      drawWrappedText(doc, label, {
        x: contentX,
        y: cursorY,
        width: 20,
        fontSize: PDF_LAYOUT.labelFontSize,
        lineGap: 2,
        bold: true,
        color: COLORS.text,
        advanceCursor: false,
      });

      const optionHeight = drawWrappedText(doc, normalizeString(option), {
        x: contentX + 24,
        y: cursorY,
        width: contentWidth - 24,
        fontSize: PDF_LAYOUT.bodyFontSize,
        lineGap: PDF_LAYOUT.lineGap,
        color: COLORS.text,
        advanceCursor: false,
      });

      cursorY += Math.max(optionHeight, 12) + SPACING.sm;
    });

    doc.y += cardHeight + SPACING.xl;
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
  const featureLabel = FEATURE_LABELS[feature] ?? "Study";
  const documentTitle = stripTrailingExtension(
    normalizeDocumentName(document?.originalName || document?.title || document?.filename),
  ) || "Study document";

  const pdf = new PDFDocument({
    size: PDF_LAYOUT.size,
    margins: PDF_LAYOUT.margins,
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
  pdf.y = PDF_LAYOUT.margins.top;

  renderDocumentHeader(pdf, documentTitle, featureLabel);
  renderSectionTitle(pdf, featureLabel);

  if (feature === "summary") {
    renderSummary(pdf, document?.summary);
  } else if (feature === "flashcards") {
    renderFlashcards(pdf, document?.flashcards);
  } else {
    renderExam(pdf, document?.examQuestions);
  }

  pdf.end();
  return bufferPromise;
}
