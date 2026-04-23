import bidiFactory from "bidi-js";
import PDFDocument from "pdfkit";
import path from "path";
import { fileURLToPath } from "url";

import { normalizeDocumentName, sanitizeDownloadFilename } from "./filenames.js";

const bidi = bidiFactory();
export const STUDY_PDF_LAYOUT_VERSION = "2026-04-20-exam-compact-v7";

const SPACING = Object.freeze({
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 40,
});

const PDF_SYSTEM = Object.freeze({
  page: {
    size: "A4",
    margins: {
      top: 40,
      bottom: 40,
      left: 48,
      right: 48,
    },
    maxContentWidth: 468,
  },
  spacing: SPACING,
  typography: {
    documentTitle: { size: 22, weight: 700, lineGap: SPACING.sm },
    sectionTitle: { size: 16, weight: 700, lineGap: SPACING.sm },
    questionText: { size: 13.5, weight: 600, lineGap: SPACING.sm },
    flashcardQuestion: { size: 10.5, weight: 600, lineGap: SPACING.sm },
    body: { size: 9.5, weight: 400, lineGap: SPACING.sm },
    label: { size: 9, weight: 700, lineGap: SPACING.xs },
    meta: { size: 9, weight: 400, lineGap: SPACING.xs },
  },
  components: {
    radius: 8,
    flashcard: {
      padding: SPACING.md,
      gapBetweenCards: SPACING.sm,
      sectionGap: SPACING.sm,
    },
    exam: {
      padding: SPACING.md,
      gapBetweenQuestions: SPACING.sm,
      optionsGap: SPACING.xs,
      optionIndent: SPACING.lg,
      dividerGap: SPACING.sm,
    },
    summary: {
      paragraphGap: SPACING.md,
      listItemGap: SPACING.sm,
      sectionGap: SPACING.lg,
    },
  },
});

const COLORS = Object.freeze({
  text: "#111827",
  strongText: "#0F172A",
  muted: "#4B5563",
  subtle: "#667085",
  border: "#CBD5E1",
  softBorder: "#D9E2EC",
  panel: "#F8FAFC",
  accentPanel: "#F3F6FB",
});

const FEATURE_LABELS = Object.freeze({
  summary: "Summary",
  flashcards: "Flashcards",
  exam: "Mock Exam",
});
const HEADER_LAYOUT = Object.freeze({
  titleToFeatureGap: SPACING.xs,
  featureToMetaGap: SPACING.xs,
  dividerBefore: SPACING.xs,
  dividerAfter: SPACING.sm,
});

const PARAGRAPH_BREAK_TOKEN = "__PARA_BREAK__";

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

function normalizeInlineSpacing(value) {
  return normalizeString(value)
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([,.;:!?%])/g, "$1")
    .replace(/([,.;:!?])(?=\S)/g, "$1 ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\[\s+/g, "[")
    .replace(/\s+\]/g, "]")
    .replace(/\{\s+/g, "{")
    .replace(/\s+\}/g, "}")
    .replace(/\s*([+–—])\s*/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitNormalizedParagraphFragments(value) {
  return normalizeString(value)
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]*\n+/g, PARAGRAPH_BREAK_TOKEN)
    .split(PARAGRAPH_BREAK_TOKEN)
    .map((part) => normalizeInlineSpacing(part.replace(/\n+/g, " ")))
    .filter(Boolean);
}

function endsParagraphSentence(value) {
  return /[.!?]["')\]]*$/.test(normalizeString(value));
}

function shouldMergeParagraphFragments(previous, next) {
  if (!previous || !next) {
    return false;
  }

  if (/^[A-Z]/.test(next)) {
    return false;
  }

  if (!endsParagraphSentence(previous)) {
    return true;
  }

  return /^[a-z(]/.test(next);
}

function normalizeParagraphText(value) {
  const fragments = splitNormalizedParagraphFragments(value);
  if (fragments.length === 0) {
    return "";
  }

  const mergedFragments = [];

  fragments.forEach((fragment) => {
    const previous = mergedFragments.at(-1);
    if (shouldMergeParagraphFragments(previous, fragment)) {
      mergedFragments[mergedFragments.length - 1] = normalizeInlineSpacing(`${previous} ${fragment}`);
      return;
    }

    mergedFragments.push(fragment);
  });

  return mergedFragments.join("\n\n").trim();
}

function stripTrailingExtension(value) {
  return normalizeString(value).replace(/\.[a-z0-9]{1,10}$/i, "");
}

function containsArabic(value) {
  return ARABIC_CHARS.test(normalizeString(value));
}

function getPageInnerWidth(doc) {
  return doc.page.width - PDF_SYSTEM.page.margins.left - PDF_SYSTEM.page.margins.right;
}

function getContentMetrics(doc) {
  const pageInnerWidth = getPageInnerWidth(doc);
  const width = Math.min(PDF_SYSTEM.page.maxContentWidth, pageInnerWidth);
  const x = PDF_SYSTEM.page.margins.left + Math.max(0, (pageInnerWidth - width) / 2);
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
  if (doc.y + height > doc.page.height - PDF_SYSTEM.page.margins.bottom) {
    doc.addPage();
    doc.y = PDF_SYSTEM.page.margins.top;
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
  const normalized = normalizeParagraphText(value).replace(/\s+/g, " ");
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

  for (let index = lines.length - 1; index > 0; index -= 1) {
    const currentTokens = lines[index].split(" ").filter(Boolean);
    const previousTokens = lines[index - 1].split(" ").filter(Boolean);

    if (currentTokens.length >= 3 || previousTokens.length <= 3) {
      continue;
    }

    const movedToken = previousTokens.pop();
    if (!movedToken) {
      continue;
    }

    lines[index - 1] = previousTokens.join(" ");
    lines[index] = `${movedToken} ${currentTokens.join(" ")}`.trim();
  }

  return lines.filter(Boolean);
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
  const fontSize = options.fontSize ?? PDF_SYSTEM.typography.body.size;
  const lineGap = options.lineGap ?? PDF_SYSTEM.typography.body.lineGap;

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
  const fontSize = options.fontSize ?? PDF_SYSTEM.typography.body.size;
  const lineGap = options.lineGap ?? PDF_SYSTEM.typography.body.lineGap;
  const color = options.color ?? COLORS.text;

  applyFont(doc, text, { bold: options.bold });
  doc.fontSize(fontSize).fillColor(color);

  const lines = wrapLogicalText(doc, text, width, direction);
  const lineAdvance = getLineAdvance(doc, lineGap);
  let cursorY = y;
  const initialDocY = doc.y;

  lines.forEach((line) => {
    const lineWidth = Math.min(measureLogicalTextWidth(doc, line, direction, { bold: options.bold }), width);
    const lineX = direction === "rtl" ? x + width - lineWidth : x;
    drawVisualLine(doc, toVisualPdfText(line, direction), lineX, cursorY, { bold: options.bold });
    cursorY += lineAdvance;
  });

  if (options.advanceCursor !== false) {
    doc.y = cursorY;
  } else {
    // `doc.text(..., { lineBreak: false })` still mutates doc.y internally.
    // Restore the incoming cursor to keep measurement/draw helpers side-effect free.
    doc.y = initialDocY;
  }

  return cursorY - y;
}

function drawPreparedLines(doc, lines, options = {}) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return 0;
  }

  const direction = options.direction ?? "ltr";
  const lineGap = options.lineGap ?? PDF_SYSTEM.typography.body.lineGap;
  const fontSize = options.fontSize ?? PDF_SYSTEM.typography.body.size;
  const x = options.x ?? 0;
  const y = options.y ?? doc.y;
  const width = options.width ?? getContentMetrics(doc).width;
  const color = options.color ?? COLORS.text;

  applyFont(doc, lines.join(" "), { bold: options.bold });
  doc.fontSize(fontSize).fillColor(color);

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

function truncateLineToWidth(doc, value, width, direction, options = {}) {
  const source = normalizeInlineSpacing(value);
  if (!source) {
    return "";
  }

  const ellipsis = "…";
  const fullWidth = measureLogicalTextWidth(doc, source, direction, { bold: options.bold });
  if (fullWidth <= width) {
    return source;
  }

  const words = source.split(/\s+/).filter(Boolean);
  let candidate = "";
  for (const word of words) {
    const next = candidate ? `${candidate} ${word}` : word;
    const nextWithEllipsis = `${next}${ellipsis}`;
    if (measureLogicalTextWidth(doc, nextWithEllipsis, direction, { bold: options.bold }) > width) {
      break;
    }
    candidate = next;
  }

  if (candidate) {
    return `${candidate}${ellipsis}`;
  }

  const chars = Array.from(source);
  let compact = "";
  for (const char of chars) {
    const next = compact + char;
    const nextWithEllipsis = `${next}${ellipsis}`;
    if (measureLogicalTextWidth(doc, nextWithEllipsis, direction, { bold: options.bold }) > width) {
      break;
    }
    compact = next;
  }

  return compact ? `${compact}${ellipsis}` : ellipsis;
}

function fitHeaderTitleLayout(doc, documentTitle, width) {
  const titleText = normalizeInlineSpacing(documentTitle) || "Study document";
  const direction = getTextDirection(titleText);
  const baseSize = PDF_SYSTEM.typography.documentTitle.size;
  const lineGap = SPACING.xs;
  const sizeSteps = [baseSize, 21, 20, 19];
  const minSize = Math.max(baseSize * 0.85, 18.5);

  for (const fontSize of sizeSteps) {
    applyFont(doc, titleText, { bold: true });
    doc.fontSize(fontSize);
    const lines = wrapLogicalText(doc, titleText, width, direction);
    if (lines.length <= 2) {
      return { lines, fontSize, lineGap, direction, truncated: false };
    }
  }

  const fittedSize = Math.max(sizeSteps[sizeSteps.length - 1], minSize);
  applyFont(doc, titleText, { bold: true });
  doc.fontSize(fittedSize);
  const wrapped = wrapLogicalText(doc, titleText, width, direction);

  if (wrapped.length <= 2) {
    return { lines: wrapped, fontSize: fittedSize, lineGap, direction, truncated: false };
  }

  const lineOne = wrapped[0] || "";
  const overflowTail = normalizeInlineSpacing(wrapped.slice(1).join(" "));
  const lineTwo = truncateLineToWidth(doc, overflowTail, width, direction, { bold: true });

  return {
    lines: [lineOne, lineTwo].filter(Boolean),
    fontSize: fittedSize,
    lineGap,
    direction,
    truncated: true,
  };
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
  const headerMetrics = computeHeaderLayoutMetrics(doc, documentTitle, featureLabel);
  const { container, titleLayout, generatedAt, spacing, totalHeight } = headerMetrics;

  ensureVerticalSpace(doc, totalHeight);
  drawPreparedLines(doc, titleLayout.lines, {
    x: container.x,
    width: container.width,
    bold: true,
    fontSize: titleLayout.fontSize,
    lineGap: titleLayout.lineGap,
    color: COLORS.strongText,
    direction: titleLayout.direction,
  });
  doc.y += spacing.titleToFeatureGap;
  drawWrappedText(doc, featureLabel, {
    x: container.x,
    width: container.width,
    fontSize: 12,
    lineGap: SPACING.xs,
    color: COLORS.text,
  });
  doc.y += spacing.featureToMetaGap;
  drawWrappedText(doc, generatedAt, {
    x: container.x,
    width: container.width,
    fontSize: PDF_SYSTEM.typography.meta.size,
    lineGap: SPACING.xs,
    color: COLORS.subtle,
  });
  drawDivider(doc, spacing.dividerBefore, spacing.dividerAfter);
}

function computeHeaderLayoutMetrics(doc, documentTitle, featureLabel) {
  const container = getContentMetrics(doc);
  const titleLayout = fitHeaderTitleLayout(doc, documentTitle, container.width);
  const titleHeight = titleLayout.lines.length * getLineAdvance(doc, titleLayout.lineGap);
  const featureHeight = getLineMetrics(doc, featureLabel, {
    width: container.width,
    fontSize: 12,
    lineGap: SPACING.xs,
  }).height;
  const generatedAt = `Generated ${new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  })}`;
  const metaHeight = getLineMetrics(doc, generatedAt, {
    width: container.width,
    fontSize: PDF_SYSTEM.typography.meta.size,
    lineGap: SPACING.xs,
  }).height;
  const spacing = HEADER_LAYOUT;
  const totalHeight = (
    titleHeight
    + spacing.titleToFeatureGap
    + featureHeight
    + spacing.featureToMetaGap
    + metaHeight
    + spacing.dividerBefore
    + 1
    + spacing.dividerAfter
  );

  return {
    container,
    titleLayout,
    generatedAt,
    titleHeight,
    featureHeight,
    metaHeight,
    spacing,
    totalHeight,
  };
}

function renderSectionTitle(doc, value) {
  const { x, width } = getContentMetrics(doc);
  const height = getLineMetrics(doc, value, {
    width,
    bold: true,
    fontSize: PDF_SYSTEM.typography.sectionTitle.size,
    lineGap: PDF_SYSTEM.typography.sectionTitle.lineGap,
  }).height + SPACING.md;

  ensureVerticalSpace(doc, height);
  drawWrappedText(doc, value, {
    x,
    width,
    bold: true,
    fontSize: PDF_SYSTEM.typography.sectionTitle.size,
    lineGap: PDF_SYSTEM.typography.sectionTitle.lineGap,
    color: COLORS.strongText,
  });
  doc.y += SPACING.md;
}

function renderSubsectionTitle(doc, value) {
  const { x, width } = getContentMetrics(doc);
  const height = getLineMetrics(doc, value, {
    width,
    bold: true,
    fontSize: PDF_SYSTEM.typography.sectionTitle.size,
    lineGap: PDF_SYSTEM.typography.sectionTitle.lineGap,
  }).height + SPACING.sm;

  ensureVerticalSpace(doc, height);
  drawWrappedText(doc, value, {
    x,
    width,
    bold: true,
    fontSize: PDF_SYSTEM.typography.sectionTitle.size,
    lineGap: PDF_SYSTEM.typography.sectionTitle.lineGap,
    color: COLORS.strongText,
  });
  doc.y += SPACING.sm;
}

function renderBodyParagraph(doc, value, options = {}) {
  const { x, width } = getContentMetrics(doc);
  const normalizedValue = normalizeParagraphText(value);
  const height = getLineMetrics(doc, normalizedValue, {
    width: options.width ?? width,
    bold: options.bold,
    fontSize: options.fontSize ?? PDF_SYSTEM.typography.body.size,
    lineGap: options.lineGap ?? PDF_SYSTEM.typography.body.lineGap,
    direction: options.direction,
  }).height + (options.spacingAfter ?? PDF_SYSTEM.components.summary.paragraphGap);

  ensureVerticalSpace(doc, height);
  drawWrappedText(doc, normalizedValue, {
    x: options.x ?? x,
    width: options.width ?? width,
    bold: options.bold,
    fontSize: options.fontSize ?? PDF_SYSTEM.typography.body.size,
    lineGap: options.lineGap ?? PDF_SYSTEM.typography.body.lineGap,
    color: options.color ?? COLORS.text,
    direction: options.direction,
  });
  doc.y += options.spacingAfter ?? PDF_SYSTEM.components.summary.paragraphGap;
}

function normalizeBulletText(value) {
  return normalizeParagraphText(value)
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+[.)]\s+/, "");
}

function parseSummaryListItem(rawLine = "") {
  const line = typeof rawLine === "string" ? rawLine.replace(/\t/g, "    ") : "";
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const indentMatch = line.match(/^(\s*)/);
  const indentLength = indentMatch ? indentMatch[1].length : 0;
  const bulletMatch = trimmed.match(/^([-*â€¢]|\d+[.)])\s+/);
  if (!bulletMatch) {
    return null;
  }

  const marker = bulletMatch[1];
  const ordered = /^\d/.test(marker);
  const level = Math.max(0, Math.min(2, Math.floor(indentLength / 2)));
  const text = normalizeBulletText(trimmed);

  if (!text) {
    return null;
  }

  return {
    text,
    level,
    ordered,
    marker,
  };
}

function splitSentenceGroups(text) {
  return normalizeParagraphText(text)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitEditorialParagraphs(text) {
  const normalized = normalizeParagraphText(text);
  if (!normalized) {
    return [];
  }

  const exampleSplit = normalized
    .split(/\s+(?=Example Case[:\-])/i)
    .map((part) => part.trim())
    .filter(Boolean);

  return exampleSplit.flatMap((part) => {
    const sentences = splitSentenceGroups(part);
    if (sentences.length <= 2) {
      return [part];
    }

    const grouped = [];
    for (let index = 0; index < sentences.length; index += 2) {
      grouped.push(sentences.slice(index, index + 2).join(" "));
    }
    return grouped;
  });
}

function parseSummaryBlocks(summary) {
  const source = normalizeString(summary);
  if (!source) {
    return [];
  }

  const rawBlocks = source
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .reduce((blocks, block) => {
      const previous = blocks.at(-1);
      if (
        previous
        && !/^##\s+/.test(previous)
        && !/^[-*•]\s+/.test(previous)
        && !/^\d+[.)]\s+/.test(previous)
        && !/^##\s+/.test(block)
        && !/^[-*•]\s+/.test(block)
        && !/^\d+[.)]\s+/.test(block)
        && shouldMergeParagraphFragments(normalizeParagraphText(previous), normalizeParagraphText(block))
      ) {
        blocks[blocks.length - 1] = `${previous}\n\n${block}`;
        return blocks;
      }

      blocks.push(block);
      return blocks;
    }, []);

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

    const normalizedParagraph = normalizeParagraphText(proseLines.join(" "));
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

    splitEditorialParagraphs(normalizedParagraph).forEach((paragraph) => {
      blocks.push({ type: "paragraph", text: paragraph });
    });

    if (bulletItems.length > 0) {
      blocks.push({ type: "list", items: bulletItems });
    }
  });

  return blocks;
}

function parseSummarySectionLine(line = "") {
  const normalized = normalizeString(line);
  if (!normalized || /^[-*â€¢]\s+/.test(normalized) || /^\d+[.)]\s+/.test(normalized)) {
    return null;
  }

  if (/^##\s+/.test(normalized)) {
    return {
      title: normalizeString(normalized.replace(/^##\s+/, "")),
      remainder: "",
    };
  }

  const match = normalized.match(/^([^:]{1,80}):\s*(.*)$/);
  if (!match) {
    return null;
  }

  const title = normalizeInlineSpacing(match[1]);
  if (!title || /[.!?]/.test(title) || title.split(/\s+/).length > 8) {
    return null;
  }

  return {
    title,
    remainder: normalizeString(match[2]),
  };
}

function buildSummarySections(summary) {
  const source = normalizeString(summary).replace(/\r\n?/g, "\n");
  if (!source) {
    return [];
  }

  const sections = [];
  let currentSection = null;
  let paragraphLines = [];
  let listItems = [];

  const ensureSection = (fallbackTitle = "Summary") => {
    if (!currentSection) {
      currentSection = { title: fallbackTitle, blocks: [] };
      sections.push(currentSection);
    }
    return currentSection;
  };

  const flushParagraph = () => {
    const paragraph = normalizeParagraphText(paragraphLines.join(" "));
    paragraphLines = [];
    if (!paragraph) {
      return;
    }

    const target = ensureSection();
    splitEditorialParagraphs(paragraph).forEach((text) => {
      target.blocks.push({ type: "paragraph", text });
    });
  };

  const flushList = () => {
    if (listItems.length === 0) {
      return;
    }

    const target = ensureSection();
    target.blocks.push({ type: "list", items: listItems });
    listItems = [];
  };

  source.split("\n").forEach((rawLine) => {
    const line = rawLine.trim();

    if (!line) {
      flushParagraph();
      flushList();
      return;
    }

    const sectionLine = parseSummarySectionLine(line);
    if (sectionLine) {
      flushParagraph();
      flushList();
      currentSection = {
        title: sectionLine.title,
        blocks: [],
      };
      sections.push(currentSection);

      if (sectionLine.remainder) {
        splitEditorialParagraphs(sectionLine.remainder).forEach((text) => {
          currentSection.blocks.push({ type: "paragraph", text });
        });
      }
      return;
    }

    if (/^[-*â€¢]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) {
      flushParagraph();
      listItems.push(normalizeBulletText(line));
      return;
    }

    flushList();
    paragraphLines.push(line);
  });

  flushParagraph();
  flushList();

  const nonEmptySections = sections.filter((section) => Array.isArray(section.blocks) && section.blocks.length > 0);
  if (nonEmptySections.length > 0) {
    return nonEmptySections;
  }

  const fallbackBlocks = parseSummaryBlocks(summary);
  if (fallbackBlocks.length === 0) {
    return [];
  }

  return [{
    title: "Summary",
    blocks: fallbackBlocks,
  }];
}

function buildSummarySectionsForPdf(summary) {
  const source = normalizeString(summary).replace(/\r\n?/g, "\n");
  if (!source) {
    return [];
  }

  const sections = [];
  let currentSection = null;
  let paragraphLines = [];
  let listItems = [];

  const ensureSection = (fallbackTitle = "Summary") => {
    if (!currentSection) {
      currentSection = { title: fallbackTitle, blocks: [] };
      sections.push(currentSection);
    }
    return currentSection;
  };

  const flushParagraph = () => {
    const paragraph = normalizeParagraphText(paragraphLines.join(" "));
    paragraphLines = [];
    if (!paragraph) {
      return;
    }

    const target = ensureSection();
    splitEditorialParagraphs(paragraph).forEach((text) => {
      target.blocks.push({ type: "paragraph", text });
    });
  };

  const flushList = () => {
    if (listItems.length === 0) {
      return;
    }

    const target = ensureSection();
    target.blocks.push({ type: "list", items: listItems });
    listItems = [];
  };

  source.split("\n").forEach((rawLine) => {
    const line = rawLine.trim();

    if (!line) {
      flushParagraph();
      flushList();
      return;
    }

    const sectionLine = parseSummarySectionLine(line);
    if (sectionLine) {
      flushParagraph();
      flushList();
      currentSection = {
        title: sectionLine.title,
        blocks: [],
      };
      sections.push(currentSection);

      if (sectionLine.remainder) {
        splitEditorialParagraphs(sectionLine.remainder).forEach((text) => {
          currentSection.blocks.push({ type: "paragraph", text });
        });
      }
      return;
    }

    const listItem = parseSummaryListItem(rawLine);
    if (listItem) {
      flushParagraph();
      listItems.push(listItem);
      return;
    }

    flushList();
    paragraphLines.push(line);
  });

  flushParagraph();
  flushList();

  const nonEmptySections = sections.filter((section) => Array.isArray(section.blocks) && section.blocks.length > 0);
  if (nonEmptySections.length > 0) {
    return nonEmptySections;
  }

  return buildSummarySections(summary);
}

function renderBulletList(doc, items, options = {}) {
  const { x, width } = getContentMetrics(doc);
  const indent = options.indent ?? SPACING.md;
  const markerGap = options.markerGap ?? SPACING.sm;
  const marker = options.marker ?? "•";
  const contentWidth = width - indent;
  const itemGap = options.itemGap ?? PDF_SYSTEM.components.summary.listItemGap;

  items.forEach((item, index) => {
    const bulletText = normalizeString(item);
    if (!bulletText) {
      return;
    }

    const lineMetrics = getLineMetrics(doc, bulletText, {
      width: contentWidth - markerGap,
      fontSize: options.fontSize ?? PDF_SYSTEM.typography.body.size,
      lineGap: options.lineGap ?? PDF_SYSTEM.typography.body.lineGap,
      direction: options.direction,
    });
    const blockHeight = Math.max(lineMetrics.height, PDF_SYSTEM.typography.body.size);
    const spacingAfter = index < items.length - 1 ? itemGap : 0;

    ensureVerticalSpace(doc, blockHeight + spacingAfter);
    drawWrappedText(doc, marker, {
      x,
      y: doc.y,
      width: indent,
      fontSize: PDF_SYSTEM.typography.label.size,
      bold: true,
      lineGap: PDF_SYSTEM.typography.label.lineGap,
      color: COLORS.text,
      advanceCursor: false,
    });
    drawWrappedText(doc, bulletText, {
      x: x + indent,
      y: doc.y,
      width: contentWidth - markerGap,
      fontSize: options.fontSize ?? PDF_SYSTEM.typography.body.size,
      lineGap: options.lineGap ?? PDF_SYSTEM.typography.body.lineGap,
      color: options.color ?? COLORS.text,
      direction: options.direction,
      advanceCursor: false,
    });
    doc.y += blockHeight + spacingAfter;
  });
}

function renderSummaryBulletList(doc, items, options = {}) {
  const { x, width } = getContentMetrics(doc);
  const baseIndent = options.indent ?? SPACING.md;
  const markerGap = options.markerGap ?? SPACING.sm;
  const itemGap = options.itemGap ?? PDF_SYSTEM.components.summary.listItemGap;
  const nestedIndentStep = options.nestedIndentStep ?? 14;

  items.forEach((item, index) => {
    const bulletText = normalizeString(typeof item === "string" ? item : item?.text);
    if (!bulletText) {
      return;
    }

    const level = Number.isFinite(Number(item?.level)) ? Number(item.level) : 0;
    const indent = baseIndent + (level * nestedIndentStep);
    const contentWidth = width - indent;
    const marker = typeof item === "object" && item?.ordered
      ? `${index + 1}.`
      : "•";
    const isLabelLike = /:\s*$/.test(bulletText);
    const fontSize = options.fontSize ?? PDF_SYSTEM.typography.body.size;
    const lineGap = options.lineGap ?? PDF_SYSTEM.typography.body.lineGap;
    const lineMetrics = getLineMetrics(doc, bulletText, {
      width: contentWidth - markerGap,
      fontSize,
      lineGap,
      direction: options.direction,
      bold: isLabelLike,
    });
    const blockHeight = Math.max(lineMetrics.height, PDF_SYSTEM.typography.body.size);
    const spacingAfter = index < items.length - 1 ? itemGap : 0;

    ensureVerticalSpace(doc, blockHeight + spacingAfter);
    drawWrappedText(doc, marker, {
      x,
      y: doc.y,
      width: indent,
      fontSize: PDF_SYSTEM.typography.label.size,
      bold: true,
      lineGap: PDF_SYSTEM.typography.label.lineGap,
      color: COLORS.text,
      advanceCursor: false,
    });
    drawWrappedText(doc, bulletText, {
      x: x + indent,
      y: doc.y,
      width: contentWidth - markerGap,
      fontSize,
      lineGap,
      color: options.color ?? COLORS.text,
      direction: options.direction,
      bold: isLabelLike,
      advanceCursor: false,
    });
    doc.y += blockHeight + spacingAfter;
  });
}

function measureLabeledTextBlock(doc, label, text, options = {}) {
  const width = options.width;
  const labelMetrics = getLineMetrics(doc, label, {
    width,
    bold: true,
    fontSize: PDF_SYSTEM.typography.label.size,
    lineGap: PDF_SYSTEM.typography.label.lineGap,
    direction: getTextDirection(label),
  });
  const textMetrics = getLineMetrics(doc, normalizeParagraphText(text), {
    width,
    bold: options.bold,
    fontSize: options.fontSize ?? PDF_SYSTEM.typography.body.size,
    lineGap: options.lineGap ?? PDF_SYSTEM.typography.body.lineGap,
    direction: options.direction,
  });

  return labelMetrics.height + SPACING.xs + textMetrics.height;
}

function drawLabeledTextBlock(doc, label, text, options = {}) {
  const labelHeight = drawWrappedText(doc, label, {
    x: options.x,
    y: options.y,
    width: options.width,
    fontSize: PDF_SYSTEM.typography.label.size,
    lineGap: PDF_SYSTEM.typography.label.lineGap,
    bold: true,
    color: options.labelColor ?? COLORS.subtle,
    advanceCursor: false,
  });

  const textY = options.y + labelHeight + SPACING.xs;
  const textHeight = drawWrappedText(doc, normalizeParagraphText(text), {
    x: options.x,
    y: textY,
    width: options.width,
    fontSize: options.fontSize ?? PDF_SYSTEM.typography.body.size,
    lineGap: options.lineGap ?? PDF_SYSTEM.typography.body.lineGap,
    bold: options.bold,
    color: options.color ?? COLORS.text,
    direction: options.direction,
    advanceCursor: false,
  });

  return {
    height: labelHeight + SPACING.xs + textHeight,
    nextY: textY + textHeight,
  };
}

function measureCardHeight(doc, segments, width) {
  let total = PDF_SYSTEM.components.flashcard.padding * 2;

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
  const contentX = cardX + PDF_SYSTEM.components.flashcard.padding;
  const contentWidth = cardWidth - (PDF_SYSTEM.components.flashcard.padding * 2);
  const cardHeight = measureCardHeight(doc, segments, contentWidth);

  ensureVerticalSpace(doc, cardHeight);

  doc
    .save()
    .roundedRect(cardX, doc.y, cardWidth, cardHeight, PDF_SYSTEM.components.radius)
    .fillAndStroke(options.fillColor ?? COLORS.panel, options.strokeColor ?? COLORS.border)
    .restore();

  let cursorY = doc.y + PDF_SYSTEM.components.flashcard.padding;

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

  doc.y += cardHeight + (options.spacingAfter ?? PDF_SYSTEM.components.flashcard.gapBetweenCards);
}

function renderSummary(doc, summary) {
  const sections = buildSummarySectionsForPdf(summary);

  sections.forEach((section, sectionIndex) => {
    if (!section || !Array.isArray(section.blocks) || section.blocks.length === 0) {
      return;
    }

    renderSubsectionTitle(doc, section.title);

    section.blocks.forEach((block, blockIndex) => {
      const spacingAfter = blockIndex === section.blocks.length - 1 ? 0 : SPACING.sm;

      if (block.type === "list") {
        renderSummaryBulletList(doc, block.items, {
          itemGap: PDF_SYSTEM.components.summary.listItemGap,
        });
        doc.y += spacingAfter;
        return;
      }

      renderBodyParagraph(doc, block.text, {
        spacingAfter,
      });
    });

    if (sectionIndex < sections.length - 1) {
      doc.y += SPACING.md;
    }
  });
}

export const __studyPdfTestables = Object.freeze({
  PDF_SYSTEM,
  FEATURE_LABELS,
  getTextDirection,
  toVisualPdfText,
  wrapLogicalText,
  drawWrappedText,
  fitHeaderTitleLayout,
  computeHeaderLayoutMetrics,
  parseSummaryBlocks,
  buildSummarySections,
  buildSummarySectionsForPdf,
  normalizeInlineSpacing,
  normalizeParagraphText,
  measureFlashcardCardHeight,
  computeFlashcardLayoutPlan,
  measureExamQuestionBlock,
  getExamQuestionType,
  getRenderableExamOptions,
  getExamQuestionLabel,
  getExamOptionLabel,
  orderExamQuestionsForPdf,
  registerPdfFonts,
});

function measureFlashcardCardHeight(doc, flashcard, index, contentWidth) {
  const questionText = normalizeParagraphText(flashcard?.question) || "No question provided.";
  const answerText = normalizeParagraphText(flashcard?.answer) || "No answer provided.";
  const explanation = normalizeString(flashcard?.explanation);
  const questionLabel = `Question ${index + 1}`;

  let cardHeight = PDF_SYSTEM.components.flashcard.padding * 2;
  cardHeight += measureLabeledTextBlock(doc, questionLabel, questionText, {
    width: contentWidth,
    fontSize: PDF_SYSTEM.typography.flashcardQuestion.size,
    lineGap: SPACING.xs,
  });
  cardHeight += PDF_SYSTEM.components.flashcard.sectionGap;
  cardHeight += measureLabeledTextBlock(doc, "Answer", answerText, {
    width: contentWidth,
    fontSize: PDF_SYSTEM.typography.body.size,
    lineGap: SPACING.xs,
  });

  if (explanation) {
    cardHeight += PDF_SYSTEM.components.flashcard.sectionGap;
    cardHeight += measureLabeledTextBlock(doc, "Explanation", explanation, {
      width: contentWidth,
      fontSize: PDF_SYSTEM.typography.body.size,
      lineGap: SPACING.xs,
      color: COLORS.muted,
    });
  }

  return {
    questionLabel,
    questionText,
    answerText,
    explanation,
    cardHeight,
  };
}

function computeFlashcardLayoutPlan(doc, flashcards = [], startY = doc.y) {
  const container = getContentMetrics(doc);
  const cardX = container.x;
  const cardWidth = container.width;
  const contentX = cardX + PDF_SYSTEM.components.flashcard.padding;
  const contentWidth = cardWidth - (PDF_SYSTEM.components.flashcard.padding * 2);
  const cards = [];
  let cursorY = startY;

  flashcards.forEach((flashcard, index) => {
    const measured = measureFlashcardCardHeight(doc, flashcard, index, contentWidth);
    const gapAfter = index < flashcards.length - 1 ? PDF_SYSTEM.components.flashcard.gapBetweenCards : 0;
    const nextY = cursorY + measured.cardHeight + gapAfter;

    cards.push({
      index,
      cardX,
      cardWidth,
      contentX,
      contentWidth,
      yStart: cursorY,
      nextY,
      gapAfter,
      ...measured,
    });

    cursorY = nextY;
  });

  return {
    container,
    startY,
    endY: cursorY,
    cards,
  };
}

function renderFlashcards(doc, flashcards = []) {
  const { cards } = computeFlashcardLayoutPlan(doc, flashcards, doc.y);

  cards.forEach((card) => {
    const {
      cardX,
      cardWidth,
      contentX,
      contentWidth,
      questionLabel,
      questionText,
      answerText,
      explanation,
      cardHeight,
      gapAfter,
      index,
    } = card;
    // Page-fit by card box only; apply inter-card gap after drawing to avoid premature page breaks.
    ensureVerticalSpace(doc, cardHeight);
    doc
      .save()
      .roundedRect(cardX, doc.y, cardWidth, cardHeight, PDF_SYSTEM.components.radius)
      .lineWidth(1.15)
      .fillAndStroke(index % 2 === 0 ? COLORS.panel : COLORS.accentPanel, COLORS.border)
      .restore();

    let cursorY = doc.y + PDF_SYSTEM.components.flashcard.padding;

    cursorY = drawLabeledTextBlock(doc, questionLabel, questionText, {
      x: contentX,
      y: cursorY,
      width: contentWidth,
      fontSize: PDF_SYSTEM.typography.flashcardQuestion.size,
      lineGap: SPACING.xs,
      color: COLORS.strongText,
    }).nextY;

    cursorY += PDF_SYSTEM.components.flashcard.sectionGap;

    cursorY = drawLabeledTextBlock(doc, "Answer", answerText, {
      x: contentX,
      y: cursorY,
      width: contentWidth,
      fontSize: PDF_SYSTEM.typography.body.size,
      lineGap: SPACING.xs,
      color: COLORS.muted,
    }).nextY;

    if (explanation) {
      cursorY += PDF_SYSTEM.components.flashcard.sectionGap;
      drawLabeledTextBlock(doc, "Explanation", explanation, {
        x: contentX,
        y: cursorY,
        width: contentWidth,
        fontSize: PDF_SYSTEM.typography.body.size,
        lineGap: SPACING.xs,
        color: COLORS.muted,
      });
    }

    // Single source of inter-card spacing (no stacked margins).
    doc.y += cardHeight + gapAfter;
  });
}

function getExamQuestionType(question) {
  const explicitType = normalizeString(question?.questionType || question?.type).toLowerCase();
  if (explicitType === "mcq" || explicitType === "multiple_choice" || explicitType === "multiplechoice") {
    return "mcq";
  }
  if (explicitType === "true_false" || explicitType === "truefalse" || explicitType === "tf") {
    return "true_false";
  }

  const options = Array.isArray(question?.options)
    ? question.options.map((option) => normalizeParagraphText(option)).filter(Boolean)
    : [];
  return options.length > 0 ? "mcq" : "true_false";
}

function getRenderableExamOptions(question, questionType = getExamQuestionType(question)) {
  const normalizedOptions = Array.isArray(question?.options)
    ? question.options.map((option) => normalizeParagraphText(option)).filter(Boolean)
    : [];

  if (questionType === "true_false") {
    return ["True", "False"];
  }

  return normalizedOptions;
}

function getExamQuestionLabel(index, questionType) {
  const typeSuffix = questionType === "true_false" ? "True/False" : "Multiple Choice";
  return `Question ${index + 1} (${typeSuffix})`;
}

function getExamOptionLabel(questionType, optionIndex) {
  if (questionType === "true_false") {
    return "";
  }
  return `${String.fromCharCode(65 + optionIndex)}.`;
}

function orderExamQuestionsForPdf(questions = []) {
  const normalizedQuestions = Array.isArray(questions) ? questions : [];
  const mcq = [];
  const trueFalse = [];

  normalizedQuestions.forEach((question) => {
    if (getExamQuestionType(question) === "true_false") {
      trueFalse.push(question);
      return;
    }
    mcq.push(question);
  });

  return [...mcq, ...trueFalse];
}

function measureExamQuestionBlock(doc, question, index, width) {
  let height = PDF_SYSTEM.components.exam.padding * 2;
  const questionType = getExamQuestionType(question);
  const questionLabel = getExamQuestionLabel(index, questionType);
  height += measureLabeledTextBlock(doc, questionLabel, normalizeParagraphText(question?.question) || "No question provided.", {
    width,
    bold: true,
    fontSize: PDF_SYSTEM.typography.questionText.size,
    lineGap: PDF_SYSTEM.typography.questionText.lineGap,
  });

  const options = getRenderableExamOptions(question, questionType);
  if (options.length > 0) {
    height += PDF_SYSTEM.components.exam.dividerGap;
    options.forEach((option) => {
      const metrics = getLineMetrics(doc, normalizeParagraphText(option), {
        width: width - PDF_SYSTEM.components.exam.optionIndent,
        fontSize: PDF_SYSTEM.typography.body.size,
        lineGap: PDF_SYSTEM.typography.body.lineGap,
      });
      height += Math.max(metrics.height, PDF_SYSTEM.typography.body.size) + PDF_SYSTEM.components.exam.optionsGap;
    });
  }

  return height;
}

function renderExam(doc, questions = []) {
  const orderedQuestions = orderExamQuestionsForPdf(questions);

  orderedQuestions.forEach((question, index) => {
    const { x, width } = getContentMetrics(doc);
    const blockX = x;
    const blockWidth = width;
    const contentX = blockX + PDF_SYSTEM.components.exam.padding;
    const contentWidth = blockWidth - (PDF_SYSTEM.components.exam.padding * 2);
    const questionType = getExamQuestionType(question);
    const questionLabel = getExamQuestionLabel(index, questionType);
    const options = getRenderableExamOptions(question, questionType);
    const questionText = normalizeParagraphText(question?.question) || "No question provided.";
    const blockHeight = measureExamQuestionBlock(doc, question, index, contentWidth);

    ensureVerticalSpace(doc, blockHeight + PDF_SYSTEM.components.exam.gapBetweenQuestions);

    doc
      .save()
      .roundedRect(blockX, doc.y, blockWidth, blockHeight, PDF_SYSTEM.components.radius)
      .lineWidth(1.1)
      .fillAndStroke(COLORS.panel, COLORS.border)
      .restore();

    let cursorY = doc.y + PDF_SYSTEM.components.exam.padding;
    cursorY = drawLabeledTextBlock(doc, questionLabel, questionText, {
      x: contentX,
      y: cursorY,
      width: contentWidth,
      bold: true,
      fontSize: PDF_SYSTEM.typography.questionText.size,
      lineGap: PDF_SYSTEM.typography.questionText.lineGap,
      color: COLORS.strongText,
    }).nextY;

    if (options.length > 0) {
      cursorY += PDF_SYSTEM.components.exam.dividerGap;
      doc
        .save()
        .lineWidth(1)
        .strokeColor(COLORS.softBorder)
        .moveTo(contentX, cursorY)
        .lineTo(contentX + contentWidth, cursorY)
        .stroke()
        .restore();
      cursorY += PDF_SYSTEM.components.exam.dividerGap;
    }

    options.forEach((option, optionIndex) => {
      const label = getExamOptionLabel(questionType, optionIndex);
      const hasLabel = Boolean(label);

      if (hasLabel) {
        drawWrappedText(doc, label, {
          x: contentX,
          y: cursorY,
          width: PDF_SYSTEM.components.exam.optionIndent - SPACING.sm,
          fontSize: PDF_SYSTEM.typography.label.size,
          lineGap: PDF_SYSTEM.typography.label.lineGap,
          bold: true,
          color: COLORS.text,
          advanceCursor: false,
        });
      }

      const optionHeight = drawWrappedText(doc, normalizeParagraphText(option), {
        x: hasLabel ? contentX + PDF_SYSTEM.components.exam.optionIndent : contentX,
        y: cursorY,
        width: hasLabel ? contentWidth - PDF_SYSTEM.components.exam.optionIndent : contentWidth,
        fontSize: PDF_SYSTEM.typography.body.size,
        lineGap: PDF_SYSTEM.typography.body.lineGap,
        color: COLORS.muted,
        advanceCursor: false,
      });

      cursorY += Math.max(optionHeight, PDF_SYSTEM.typography.body.size) + PDF_SYSTEM.components.exam.optionsGap;
    });

    doc.y += blockHeight + PDF_SYSTEM.components.exam.gapBetweenQuestions;
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
  )
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .trim();
  const featureLabel = normalizeStudyExportFeature(feature) || "study";
  return sanitizeDownloadFilename(`${baseName}-${featureLabel}.pdf`, `study-document-${featureLabel}.pdf`)
    .replace(/\s+/g, "_");
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
    size: PDF_SYSTEM.page.size,
    margins: PDF_SYSTEM.page.margins,
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
  pdf.y = PDF_SYSTEM.page.margins.top;

  renderDocumentHeader(pdf, documentTitle, featureLabel);

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
