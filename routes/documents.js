import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import dotenv from "dotenv";
import OpenAI from "openai";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import { getMonthlyLimit } from "../utils/limits.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const hasOpenAIKey = Boolean(process.env.OPENAI_API_KEY);
if (!hasOpenAIKey) {
  console.warn("OPENAI_API_KEY is not set. Document processing will fail.");
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, "..", "uploads"));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Invalid file type. Only PDF, DOCX, and PPTX files are allowed.",
        ),
      );
    }
  },
});

const extractTextFromFile = async (filepath, mimetype) => {
  try {
    if (mimetype === "application/pdf") {
      const dataBuffer = await fs.readFile(filepath);
      const data = await pdfParse(dataBuffer);
      return data.text;
    }

    if (
      mimetype ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      const result = await mammoth.extractRawText({ path: filepath });
      return result.value;
    }

    if (
      mimetype ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    ) {
      return "PowerPoint content extraction - implement with pptx parser library";
    }

    return "";
  } catch (error) {
    console.error("Error extracting text:", error);
    throw error;
  }
};

const generateStudyMaterials = async (text, language) => {
  const languageName = language === "arabic" ? "Arabic" : "English";

  const prompt = `You are an expert educational content creator. Analyze the following document and create comprehensive study materials in ${languageName}.

Document content:
${text.substring(0, 8000)} 

Generate the following study materials (respond ONLY with valid JSON, no markdown formatting):

1. A summary (1-4 paragraphs based on content length)
2. Flashcards (5-20 cards based on content - each with "question" and "answer")
3. Exam questions (5-10 questions based on content):
   - Mix of: multiple choice (MCQ), true/false, and short answer
   - Each question must have: "type", "question", "options" (array for MCQ), "correctAnswer", "explanation"

Important rules:
- Adapt the number of flashcards and questions to the content length
- For short content (< 500 words): 5-8 flashcards, 5 questions
- For medium content (500-2000 words): 10-15 flashcards, 8 questions
- For long content (> 2000 words): 15-20 flashcards, 10 questions
- All content must be in ${languageName}
- For MCQ, provide 4 options as full text strings (NOT letters like A, B, C, D)
- CRITICAL: "correctAnswer" MUST be the EXACT full text of the correct option from the "options" array, NOT a letter reference
- For true/false, options should be ["True", "False"] or ["صحيح", "خطأ"] for Arabic
- Explanations should be brief (1-2 sentences) and reference the material

Return ONLY this JSON structure:
{
  "summary": "...",
  "flashcards": [{"question": "...", "answer": "..."}],
  "examQuestions": [
    {
      "type": "mcq",
      "question": "What is the main purpose of X?",
      "options": ["Full text of option 1", "Full text of option 2", "Full text of option 3", "Full text of option 4"],
      "correctAnswer": "Full text of option 1",
      "explanation": "Brief explanation here"
    }
  ]
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 3000,
    });

    const responseText = completion.choices[0].message.content.trim();
    const cleanedResponse = responseText.replace(/^```json\s*|\s*```$/g, "");

    return JSON.parse(cleanedResponse);
  } catch (error) {
    console.error("OpenAI API Error:", error);
    throw error;
  }
};

const resetMonthlyUsageIfNeeded = async (prisma, user) => {
  const now = new Date();
  const lastReset = new Date(user.lastReset);
  const daysSinceReset = (now - lastReset) / (1000 * 60 * 60 * 24);

  if (daysSinceReset < 30) {
    return user;
  }

  return prisma.user.update({
    where: { id: user.id },
    data: { documentsUsed: 0, lastReset: now },
  });
};

export const createDocumentsRouter = ({ prisma, requireAuth }) => {
  const router = express.Router();

  router.post("/upload", requireAuth, upload.single("file"), async (req, res) => {
    try {
      const { language } = req.body;
      const file = req.file;
      const user = req.session.user;
      const selectedLanguage = language === "arabic" ? "arabic" : "english";

      console.log("Upload request received:", {
        userId: user?.id,
        fileName: file?.originalname,
        fileType: file?.mimetype,
        fileSize: file?.size,
      });

      if (!file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      let dbUser = await prisma.user.findUnique({ where: { id: user.id } });
      if (!dbUser) {
        await fs.unlink(file.path).catch(() => {});
        return res.status(404).json({ error: "User not found" });
      }

      dbUser = await resetMonthlyUsageIfNeeded(prisma, dbUser);

      if (dbUser.storageUsed === null) {
        await prisma.user.update({
          where: { id: dbUser.id },
          data: { storageUsed: BigInt(0) },
        });
        dbUser.storageUsed = BigInt(0);
      }

      const monthlyLimit = getMonthlyLimit(dbUser);
      if (dbUser.documentsUsed >= monthlyLimit) {
        await fs.unlink(file.path).catch(() => {});
        return res.status(403).json({
          error: "Monthly upload limit reached",
          details: dbUser.plan === "premium" || dbUser.role === "admin"
            ? "Upgrade for more"
            : "Free limit reached",
        });
      }

      const text = await extractTextFromFile(file.path, file.mimetype);

      if (!text || text.trim().length < 50) {
        await fs.unlink(file.path).catch(() => {});
        return res
          .status(400)
          .json({ error: "Could not extract enough text from file" });
      }

      const studyMaterials = await generateStudyMaterials(text, selectedLanguage);

      const document = await prisma.document.create({
        data: {
          userId: user.id,
          filename: file.filename,
          originalName: file.originalname,
          fileType: file.mimetype,
          fileSize: file.size,
          language: selectedLanguage,
          summary: studyMaterials.summary,
          flashcards: studyMaterials.flashcards,
          examQuestions: studyMaterials.examQuestions,
        },
      });

      await prisma.user.update({
        where: { id: user.id },
        data: {
          documentsUsed: { increment: 1 },
          storageUsed: { increment: BigInt(file.size) },
        },
      });

      await fs.unlink(file.path).catch(() => {});

      res.json({
        success: true,
        document: {
          id: document.id,
          filename: document.originalName,
          summary: document.summary,
          flashcards: document.flashcards,
          examQuestions: document.examQuestions,
          uploadDate: document.uploadDate,
        },
      });
    } catch (error) {
      console.error("Upload error:", error);
      if (error?.stack) {
        console.error(error.stack);
      }
      if (req.file) {
        await fs.unlink(req.file.path).catch(() => {});
      }
      res.status(500).json({
        error: "Failed to process document",
        details: error.message,
      });
    }
  });

  router.get("/document/:id", requireAuth, async (req, res) => {
    try {
      const document = await prisma.document.findUnique({
        where: { id: req.params.id },
      });

      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }

      const isAdmin = req.session.user.role === "admin";
      if (!isAdmin && document.userId !== req.session.user.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      res.json({ document });
    } catch (error) {
      console.error("Error fetching document:", error);
      res.status(500).json({ error: "Failed to fetch document" });
    }
  });

  router.delete("/document/:id", requireAuth, async (req, res) => {
    try {
      const document = await prisma.document.findUnique({
        where: { id: req.params.id },
      });

      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }

      const isAdmin = req.session.user.role === "admin";
      if (!isAdmin && document.userId !== req.session.user.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      await prisma.document.delete({ where: { id: document.id } });
      const owner = await prisma.user.findUnique({
        where: { id: document.userId },
        select: { storageUsed: true },
      });
      const currentStorage = owner?.storageUsed ?? BigInt(0);
      const nextStorage = currentStorage - BigInt(document.fileSize);
      await prisma.user.update({
        where: { id: document.userId },
        data: {
          storageUsed: nextStorage > 0 ? nextStorage : BigInt(0),
        },
      });

      res.json({ success: true, message: "Document deleted" });
    } catch (error) {
      console.error("Error deleting document:", error);
      res.status(500).json({ error: "Failed to delete document" });
    }
  });

  return router;
};
