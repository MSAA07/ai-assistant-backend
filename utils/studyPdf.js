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
    flashcardQuestion: { size: 12.5, weight: 600, lineGap: SPACING.sm },
    body: { size: 11.5, weight: 400, lineGap: SPACING.sm },
    label: { size: 10, weight: 700, lineGap: SPACING.xs },
    meta: { size: 10, weight: 400, lineGap: SPACING.xs },
  },
  components: {
    radius: 8,
    flashcard: {
      padding: SPACING.lg,
      gapBetweenCards: SPACING.lg,
      sectionGap: SPACING.md,
    },
    exam: {
      padding: SPACING.lg,
      gapBetweenQuestions: SPACING.xl,
      optionsGap: SPACING.sm,
      optionIndent: SPACING.lg,
      dividerGap: SPACING.md,
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
  exam: "Exam",
});

const SUMMARY_SECTION_ORDER = Object.freeze([
  "Key Themes",
  "Assessment Areas",
  "Interview Structure",
]);
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
    fontSize: PDF_SYSTEM.typography.documentTitle.size,
    lineGap: PDF_SYSTEM.typography.documentTitle.lineGap,
  }).height;
  const headerFeatureHeight = getLineMetrics(doc, featureLabel, {
    width,
    fontSize: PDF_SYSTEM.typography.sectionTitle.size,
    lineGap: PDF_SYSTEM.typography.sectionTitle.lineGap,
  }).height;
  const generatedAt = `Generated ${new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  })}`;
  const metaHeight = getLineMetrics(doc, generatedAt, {
    width,
    fontSize: PDF_SYSTEM.typography.meta.size,
    lineGap: PDF_SYSTEM.typography.meta.lineGap,
  }).height;
  const blockHeight = headerTitleHeight + SPACING.sm + headerFeatureHeight + SPACING.md + metaHeight + SPACING.xl;

  ensureVerticalSpace(doc, blockHeight);
  drawWrappedText(doc, documentTitle, {
    x,
    width,
    bold: true,
    fontSize: PDF_SYSTEM.typography.documentTitle.size,
    lineGap: PDF_SYSTEM.typography.documentTitle.lineGap,
    color: COLORS.strongText,
  });
  doc.y += SPACING.sm;
  drawWrappedText(doc, featureLabel, {
    x,
    width,
    fontSize: PDF_SYSTEM.typography.sectionTitle.size,
    lineGap: PDF_SYSTEM.typography.sectionTitle.lineGap,
    color: COLORS.text,
  });
  doc.y += SPACING.md;
  drawWrappedText(doc, generatedAt, {
    x,
    width,
    fontSize: PDF_SYSTEM.typography.meta.size,
    lineGap: PDF_SYSTEM.typography.meta.lineGap,
    color: COLORS.subtle,
  });
  drawDivider(doc, SPACING.md, SPACING.xl);
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
          renderBulletList(doc, block.items, { itemGap: PDF_SYSTEM.components.summary.listItemGap });
          doc.y += PDF_SYSTEM.components.summary.paragraphGap;
          return;
        }

        renderBodyParagraph(doc, block.text, {
          spacingAfter: PDF_SYSTEM.components.summary.paragraphGap,
        });
      });
    }

    if (sectionIndex < sections.length - 1) {
      doc.y += PDF_SYSTEM.components.summary.sectionGap;
    }
  });
}

export const __studyPdfTestables = Object.freeze({
  PDF_SYSTEM,
  getTextDirection,
  toVisualPdfText,
  wrapLogicalText,
  parseSummaryBlocks,
  buildSummarySections,
  normalizeInlineSpacing,
  normalizeParagraphText,
  measureExamQuestionBlock,
  registerPdfFonts,
});

function renderFlashcards(doc, flashcards = []) {
  flashcards.forEach((flashcard, index) => {
    const questionText = normalizeParagraphText(flashcard?.question) || "No question provided.";
    const answerText = normalizeParagraphText(flashcard?.answer) || "No answer provided.";
    const explanation = normalizeString(flashcard?.explanation);
    const { x, width } = getContentMetrics(doc);
    const cardX = x;
    const cardWidth = width;
    const contentX = cardX + PDF_SYSTEM.components.flashcard.padding;
    const contentWidth = cardWidth - (PDF_SYSTEM.components.flashcard.padding * 2);
    const questionLabel = `Question ${index + 1}`;

    let cardHeight = PDF_SYSTEM.components.flashcard.padding * 2;
    cardHeight += measureLabeledTextBlock(doc, questionLabel, questionText, {
      width: contentWidth,
      fontSize: PDF_SYSTEM.typography.flashcardQuestion.size,
      lineGap: PDF_SYSTEM.typography.flashcardQuestion.lineGap,
    });
    cardHeight += PDF_SYSTEM.components.flashcard.sectionGap;
    cardHeight += measureLabeledTextBlock(doc, "Answer", answerText, {
      width: contentWidth,
      fontSize: PDF_SYSTEM.typography.body.size,
      lineGap: PDF_SYSTEM.typography.body.lineGap,
    });

    if (explanation) {
      cardHeight += PDF_SYSTEM.components.flashcard.sectionGap;
      cardHeight += measureLabeledTextBlock(doc, "Explanation", explanation, {
        width: contentWidth,
        fontSize: PDF_SYSTEM.typography.body.size,
        lineGap: PDF_SYSTEM.typography.body.lineGap,
        color: COLORS.muted,
      });
    }

    ensureVerticalSpace(doc, cardHeight + PDF_SYSTEM.components.flashcard.gapBetweenCards);
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
      lineGap: PDF_SYSTEM.typography.flashcardQuestion.lineGap,
      color: COLORS.strongText,
    }).nextY;

    cursorY += PDF_SYSTEM.components.flashcard.sectionGap;

    cursorY = drawLabeledTextBlock(doc, "Answer", answerText, {
      x: contentX,
      y: cursorY,
      width: contentWidth,
      fontSize: PDF_SYSTEM.typography.body.size,
      lineGap: PDF_SYSTEM.typography.body.lineGap,
      color: COLORS.muted,
    }).nextY;

    if (explanation) {
      cursorY += PDF_SYSTEM.components.flashcard.sectionGap;
      drawLabeledTextBlock(doc, "Explanation", explanation, {
        x: contentX,
        y: cursorY,
        width: contentWidth,
        fontSize: PDF_SYSTEM.typography.body.size,
        lineGap: PDF_SYSTEM.typography.body.lineGap,
        color: COLORS.muted,
      });
    }

    doc.y += cardHeight + PDF_SYSTEM.components.flashcard.gapBetweenCards;
  });
}

function measureExamQuestionBlock(doc, question, index, width) {
  let height = PDF_SYSTEM.components.exam.padding * 2;
  height += measureLabeledTextBlock(doc, `Question ${index + 1}`, normalizeParagraphText(question?.question) || "No question provided.", {
    width,
    bold: true,
    fontSize: PDF_SYSTEM.typography.questionText.size,
    lineGap: PDF_SYSTEM.typography.questionText.lineGap,
  });

  const options = Array.isArray(question?.options) ? question.options : [];
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
  questions.forEach((question, index) => {
    const { x, width } = getContentMetrics(doc);
    const blockX = x;
    const blockWidth = width;
    const contentX = blockX + PDF_SYSTEM.components.exam.padding;
    const contentWidth = blockWidth - (PDF_SYSTEM.components.exam.padding * 2);
    const options = Array.isArray(question?.options) ? question.options : [];
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
    cursorY = drawLabeledTextBlock(doc, `Question ${index + 1}`, questionText, {
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
      const label = `${String.fromCharCode(65 + optionIndex)}.`;
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

      const optionHeight = drawWrappedText(doc, normalizeParagraphText(option), {
        x: contentX + PDF_SYSTEM.components.exam.optionIndent,
        y: cursorY,
        width: contentWidth - PDF_SYSTEM.components.exam.optionIndent,
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
