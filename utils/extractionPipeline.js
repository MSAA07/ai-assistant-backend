import { spawn } from "child_process";
import fs from "fs";
import path from "path";

import mammoth from "mammoth";
import pdfParse from "pdf-parse";

import { countUsableExcerpts } from "./documentStatus.js";
import { updateJobProgress } from "./jobQueue.js";
import {
  ensureUserLimitExists,
  checkAndIncrementDailyDocCap,
} from "./limits.js";
import { downloadFileToTmp, safeUnlink } from "./storage.js";

function buildExtractionResult(documentId, excerptCount, excerptSource) {
  return {
    documentId,
    excerptCount,
    excerptSource,
    generated: false,
  };
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

  try {
    const existingExcerpts = await prisma.documentExcerpt.findMany({
      where: { documentId },
      orderBy: [
        { slideOrPage: "asc" },
        { charOffset: "asc" },
        { createdAt: "asc" },
      ],
    });
    const existingUsableExcerptCount = countUsableExcerpts(existingExcerpts);

    if (existingUsableExcerptCount > 0) {
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

    if (existingExcerpts.length > 0) {
      await prisma.documentExcerpt.deleteMany({
        where: { documentId },
      });
    }

    const mimeType = document.fileType;

    if (mimeType.includes("pdf")) {
      excerpts = await extractPdf(workingPath);
    } else if (mimeType.includes("wordprocessingml") || mimeType.includes("docx")) {
      excerpts = await extractDocx(workingPath);
    } else if (mimeType.includes("presentationml") || mimeType.includes("pptx")) {
      excerpts = await extractPptx(workingPath);
    } else {
      throw new Error(`Unsupported file type: ${mimeType}`);
    }

    const usableExcerptCount = countUsableExcerpts(excerpts);
    if (usableExcerptCount === 0) {
      const noContentError = new Error("No extractable content found in document");
      noContentError.code = "no_extractable_content";
      throw noContentError;
    }

    await prisma.documentExcerpt.createMany({
      data: excerpts.map((excerpt) => ({
        ...excerpt,
        documentId,
      })),
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

  return pages
    .map((pageText, index) => ({
      slideOrPage: index + 1,
      excerptType: "slide_text",
      content: pageText.trim().slice(0, 3000),
      charOffset: 0,
    }))
    .filter((excerpt) => excerpt.content.length > 0);
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
    const child = spawn("python3", [scriptPath, filePath]);
    let stdout = "";
    let stderr = "";

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
