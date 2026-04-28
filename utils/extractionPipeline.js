import { spawn } from "child_process";
import fs from "fs";
import path from "path";

import mammoth from "mammoth";
import pdfParse from "pdf-parse";

import { countUsableExcerpts } from "./documentStatus.js";
import { repairPotentialUnicodeCorruption } from "./filenames.js";
import { withJobStage } from "./jobStageEvents.js";
import { updateJobProgress } from "./jobQueue.js";
import {
  ensureUserLimitExists,
  checkAndIncrementDailyDocCap,
} from "./limits.js";
import { downloadFileToTmp, safeUnlink } from "./storage.js";

const EXTRACTED_TEXT_CHUNK_CHAR_LIMIT = 3_000;
const EXTRACTED_TEXT_CHUNK_MIN_SPLIT = 1_800;

function buildExtractionResult(documentId, excerptCount, excerptSource) {
  return {
    documentId,
    excerptCount,
    excerptSource,
    generated: false,
  };
}

export function sanitizeExtractedText(value) {
  if (typeof value !== "string") {
    return "";
  }

  return repairPotentialUnicodeCorruption(
    value
    .replace(/\u0000/g, "")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim(),
  );
}

function sanitizeExcerpt(excerpt) {
  return {
    ...excerpt,
    content: sanitizeExtractedText(excerpt?.content),
  };
}

export function chunkExtractedTextForExcerpts(text, {
  slideOrPage = 1,
  excerptType = "slide_text",
  charOffsetBase = 0,
  maxChars = EXTRACTED_TEXT_CHUNK_CHAR_LIMIT,
} = {}) {
  const normalizedText = typeof text === "string" ? text.trim() : "";
  if (!normalizedText) {
    return [];
  }

  if (normalizedText.length <= maxChars) {
    return [{
      slideOrPage,
      excerptType,
      content: normalizedText,
      charOffset: charOffsetBase,
    }];
  }

  const excerpts = [];
  let offset = 0;

  while (offset < normalizedText.length) {
    const remaining = normalizedText.length - offset;
    if (remaining <= maxChars) {
      const content = normalizedText.slice(offset).trim();
      if (content) {
        excerpts.push({
          slideOrPage,
          excerptType,
          content,
          charOffset: charOffsetBase + offset,
        });
      }
      break;
    }

    const hardEnd = offset + maxChars;
    const candidate = normalizedText.slice(offset, hardEnd);
    const splitAt = Math.max(
      candidate.lastIndexOf("\n\n"),
      candidate.lastIndexOf("\n"),
      candidate.lastIndexOf(". "),
      candidate.lastIndexOf(" "),
    );
    const relativeEnd = splitAt >= EXTRACTED_TEXT_CHUNK_MIN_SPLIT ? splitAt + 1 : maxChars;
    const content = normalizedText.slice(offset, offset + relativeEnd).trim();

    if (content) {
      excerpts.push({
        slideOrPage,
        excerptType,
        content,
        charOffset: charOffsetBase + offset,
      });
    }

    offset += relativeEnd;
  }

  return excerpts;
}

const LATIN_LANGUAGE_PROFILES = Object.freeze([
  {
    key: "english",
    words: ["the", "and", "is", "are", "with", "from", "this", "that", "for", "of"],
    chars: [],
  },
  {
    key: "spanish",
    words: ["el", "la", "los", "las", "de", "del", "para", "una", "que", "con"],
    chars: ["á", "é", "í", "ó", "ú", "ñ"],
  },
  {
    key: "french",
    words: ["le", "la", "les", "des", "une", "dans", "pour", "avec", "est", "que"],
    chars: ["à", "â", "ç", "é", "è", "ê", "ë", "î", "ï", "ô", "ù", "û", "ü"],
  },
  {
    key: "german",
    words: ["der", "die", "das", "und", "mit", "für", "ist", "nicht", "ein", "eine"],
    chars: ["ä", "ö", "ü", "ß"],
  },
  {
    key: "portuguese",
    words: ["de", "do", "da", "dos", "das", "para", "com", "uma", "que", "não"],
    chars: ["ã", "õ", "á", "â", "ê", "ç"],
  },
  {
    key: "italian",
    words: ["il", "lo", "gli", "della", "delle", "con", "per", "una", "che", "non"],
    chars: ["à", "è", "é", "ì", "ò", "ù"],
  },
  {
    key: "dutch",
    words: ["de", "het", "een", "van", "voor", "met", "dat", "niet", "zijn", "als"],
    chars: ["ij"],
  },
  {
    key: "turkish",
    words: ["ve", "bir", "ile", "için", "bu", "olan", "olarak", "da", "de", "çok"],
    chars: ["ç", "ğ", "ı", "İ", "ö", "ş", "ü"],
  },
  {
    key: "indonesian",
    words: ["dan", "yang", "untuk", "dengan", "adalah", "ini", "pada", "dari", "dalam", "atau"],
    chars: [],
  },
]);

function buildLanguageAnalysisText(excerpts = []) {
  return excerpts
    .map((excerpt) => (typeof excerpt?.content === "string" ? excerpt.content : ""))
    .join("\n")
    .slice(0, 60_000);
}

function countPatternMatches(text, pattern) {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function countWordMatches(text, words = []) {
  let total = 0;
  for (const word of words) {
    const safeWord = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    total += countPatternMatches(text, new RegExp(`\\b${safeWord}\\b`, "g"));
  }
  return total;
}

export function detectDocumentLanguage(excerpts = []) {
  const text = buildLanguageAnalysisText(excerpts);
  if (!text.trim()) {
    return "english";
  }

  const lowercaseText = text.toLowerCase();
  const scriptCounts = {
    arabic: countPatternMatches(text, /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g),
    cyrillic: countPatternMatches(text, /[\u0400-\u04FF]/g),
    devanagari: countPatternMatches(text, /[\u0900-\u097F]/g),
    hebrew: countPatternMatches(text, /[\u0590-\u05FF]/g),
    greek: countPatternMatches(text, /[\u0370-\u03FF]/g),
    bengali: countPatternMatches(text, /[\u0980-\u09FF]/g),
    thai: countPatternMatches(text, /[\u0E00-\u0E7F]/g),
    hiraganaKatakana: countPatternMatches(text, /[\u3040-\u30FF]/g),
    hangul: countPatternMatches(text, /[\uAC00-\uD7AF]/g),
    han: countPatternMatches(text, /[\u4E00-\u9FFF]/g),
    latin: countPatternMatches(text, /[A-Za-z]/g),
  };

  if (scriptCounts.hiraganaKatakana >= 5) {
    return "japanese";
  }

  if (scriptCounts.hangul >= 5) {
    return "korean";
  }

  if (scriptCounts.han >= 15) {
    return "chinese";
  }

  if (scriptCounts.devanagari >= 5) {
    return "hindi";
  }

  if (scriptCounts.bengali >= 5) {
    return "bengali";
  }

  if (scriptCounts.thai >= 5) {
    return "thai";
  }

  if (scriptCounts.hebrew >= 5) {
    return "hebrew";
  }

  if (scriptCounts.greek >= 5) {
    return "greek";
  }

  if (scriptCounts.arabic >= 5 && scriptCounts.arabic >= scriptCounts.latin / 2) {
    return "arabic";
  }

  if (scriptCounts.cyrillic >= 5) {
    const ukrainianScore = countPatternMatches(lowercaseText, /[іїєґ]/g)
      + countWordMatches(lowercaseText, ["та", "це", "для", "що", "з", "до"]);
    const russianScore = countPatternMatches(lowercaseText, /[ыэъ]/g)
      + countWordMatches(lowercaseText, ["и", "это", "для", "что", "с", "по"]);
    return ukrainianScore > russianScore ? "ukrainian" : "russian";
  }

  let bestLanguage = "english";
  let bestScore = 0;
  for (const profile of LATIN_LANGUAGE_PROFILES) {
    const wordScore = countWordMatches(lowercaseText, profile.words);
    const charScore = profile.chars.reduce(
      (sum, value) => sum + countPatternMatches(text, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")),
      0,
    );
    const totalScore = wordScore + (charScore * 2);

    if (totalScore > bestScore) {
      bestScore = totalScore;
      bestLanguage = profile.key;
    }
  }

  return bestScore >= 2 ? bestLanguage : "english";
}

export async function processExtraction(prisma, job, workerId) {
  const documentId = job.documentId ?? job.payload?.documentId;
  const filePath = job.payload?.filePath;

  if (!documentId) {
    const jobDocumentError = new Error(`Job ${job.id} is missing a documentId`);
    jobDocumentError.code = "document_not_found";
    throw jobDocumentError;
  }

  const document = await prisma.document.findUnique({
    where: { id: documentId },
  });

  if (!document) {
    const documentNotFoundError = new Error(`Document ${documentId} not found`);
    documentNotFoundError.code = "document_not_found";
    throw documentNotFoundError;
  }

  await ensureUserLimitExists(job.userId);

  if ((job.retryCount || 0) === 0) {
    await checkAndIncrementDailyDocCap(job.userId);
  }

  await updateJobProgress(prisma, job.id, workerId, 10);

  let workingPath = filePath && path.isAbsolute(filePath) ? filePath : null;
  let downloadedPath = null;

  await withJobStage(prisma, job, "file_read_download", async () => {
    if (!workingPath) {
      if (!document.storageKey) {
        throw new Error("No storage key available for document file");
      }

      if (path.isAbsolute(document.storageKey)) {
        workingPath = document.storageKey;
      } else {
        downloadedPath = await downloadFileToTmp(document.storageKey);
        workingPath = downloadedPath;
      }
    }
  }, {
    metadata: {
      fileType: document.fileType,
      storage: workingPath ? "local" : "remote",
    },
  });

  try {
    const existingExcerpts = await withJobStage(prisma, job, "excerpt_lookup", () => prisma.documentExcerpt.findMany({
      where: { documentId },
      orderBy: [
        { slideOrPage: "asc" },
        { charOffset: "asc" },
        { createdAt: "asc" },
      ],
    }));
    const existingUsableExcerptCount = countUsableExcerpts(existingExcerpts);

    if (existingUsableExcerptCount > 0) {
      await withJobStage(prisma, job, "excerpt_persistence", () => prisma.document.update({
          where: { id: documentId },
          data: {
            language: detectDocumentLanguage(existingExcerpts),
          },
        }), {
        metadata: { excerptSource: "cache", excerptCount: existingUsableExcerptCount },
      });
      await updateJobProgress(prisma, job.id, workerId, 100);
      const result = buildExtractionResult(documentId, existingUsableExcerptCount, "cache");

      return {
        documentId,
        excerptCount: existingUsableExcerptCount,
        excerptSource: "cache",
        generated: false,
        result,
      };
    }

    let excerpts = [];
    const excerptSource = "fresh";

    const mimeType = document.fileType;

    excerpts = await withJobStage(prisma, job, "text_extraction", async () => {
      if (mimeType.includes("pdf")) {
        return extractPdf(workingPath);
      }
      if (mimeType.includes("wordprocessingml") || mimeType.includes("docx")) {
        return extractDocx(workingPath);
      }
      if (mimeType.includes("presentationml") || mimeType.includes("pptx")) {
        return extractPptx(workingPath);
      }
      throw new Error(`Unsupported file type: ${mimeType}`);
    }, {
      metadata: { mimeType },
    });

    excerpts = excerpts
      .map(sanitizeExcerpt)
      .filter((excerpt) => excerpt.content.length > 0);

    const usableExcerptCount = countUsableExcerpts(excerpts);
    if (usableExcerptCount === 0) {
      const noContentError = new Error("No extractable content found in document");
      noContentError.code = "no_extractable_content";
      throw noContentError;
    }

    await withJobStage(prisma, job, "excerpt_persistence", async () => {
      if (existingExcerpts.length > 0) {
        await prisma.documentExcerpt.deleteMany({
          where: { documentId },
        });
      }

      await prisma.document.update({
        where: { id: documentId },
        data: {
          language: detectDocumentLanguage(excerpts),
        },
      });

      await prisma.documentExcerpt.createMany({
        data: excerpts.map((excerpt) => ({
          ...excerpt,
          documentId,
        })),
      });
    }, {
      metadata: { excerptSource, excerptCount: usableExcerptCount },
    });

    await updateJobProgress(prisma, job.id, workerId, 60);
    await updateJobProgress(prisma, job.id, workerId, 90);
    const result = buildExtractionResult(documentId, usableExcerptCount, excerptSource);

    return {
      documentId,
      excerptCount: usableExcerptCount,
      excerptSource,
      generated: false,
      result,
    };
  } finally {
    if (downloadedPath) {
      await safeUnlink(downloadedPath);
    }
  }
}

async function extractPdf(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  const pages = data.text.split("\f");

  return pages.flatMap((pageText, index) => chunkExtractedTextForExcerpts(pageText, {
    slideOrPage: index + 1,
    excerptType: "slide_text",
  }));
}

async function extractDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  const paragraphs = result.value.split("\n").filter((paragraph) => paragraph.trim().length > 0);
  const chunks = [];
  let currentChunk = "";
  let pageNumber = 1;

  for (const paragraph of paragraphs) {
    if (currentChunk.length + paragraph.length > 500) {
      if (currentChunk) {
        chunks.push({
          slideOrPage: pageNumber++,
          content: currentChunk.trim(),
        });
      }

      currentChunk = paragraph;
      continue;
    }

    currentChunk += `\n${paragraph}`;
  }

  if (currentChunk) {
    chunks.push({
      slideOrPage: pageNumber,
      content: currentChunk.trim(),
    });
  }

  return chunks.map((chunk) => ({
    ...chunk,
    excerptType: "slide_text",
    charOffset: 0,
  }));
}

async function extractPptx(filePath) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(process.cwd(), "scripts", "extract_pptx.py");
    const child = spawn("python3", [scriptPath, filePath], {
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
      },
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (data) => {
      stdout += data;
    });

    child.stderr.on("data", (data) => {
      stderr += data;
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`PPTX extraction failed: ${stderr || "Unknown error"}`));
        return;
      }

      try {
        const { slides, error } = JSON.parse(stdout);

        if (error) {
          reject(new Error(`PPTX extraction script error: ${error}`));
          return;
        }

        const excerpts = [];
        for (const slide of slides) {
          if (slide.text?.trim()) {
            excerpts.push({
              slideOrPage: slide.slideNumber,
              excerptType: "slide_text",
              content: slide.text.trim(),
              charOffset: 0,
            });
          }

          if (slide.speakerNotes?.trim()) {
            excerpts.push({
              slideOrPage: slide.slideNumber,
              excerptType: "speaker_note",
              content: slide.speakerNotes.trim(),
              charOffset: 0,
            });
          }

          if (slide.hasImages) {
            excerpts.push({
              slideOrPage: slide.slideNumber,
              excerptType: "image_flag",
              content: "true",
              charOffset: 0,
            });
          }
        }

        resolve(excerpts);
      } catch (error) {
        reject(new Error(`PPTX JSON parse error: ${error.message}. Stdout: ${stdout}`));
      }
    });

    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(new Error("python3 not found. Ensure python is installed."));
        return;
      }

      reject(error);
    });

    setTimeout(() => {
      child.kill();
      reject(new Error("PPTX extraction timed out after 60s"));
    }, 60_000);
  });
}
