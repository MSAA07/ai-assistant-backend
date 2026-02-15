import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { PrismaClient } from "@prisma/client";
import OpenAI from "openai";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import fs from "fs/promises";

// ES modules fix for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config(); // Works locally, fails silently on Railway (which is fine)

console.log('OPENAI_API_KEY exists:', !!process.env.OPENAI_API_KEY);
console.log('OPENAI_API_KEY length:', process.env.OPENAI_API_KEY?.length || 0);

const app = express();
const prisma = new PrismaClient();
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Middleware
app.use(cors());
app.use(express.json());

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, "uploads"));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB limit
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

// Helper function to extract text from files
async function extractTextFromFile(filepath, mimetype) {
  try {
    if (mimetype === "application/pdf") {
      const dataBuffer = await fs.readFile(filepath);
      const data = await pdfParse(dataBuffer);
      return data.text;
    } else if (
      mimetype ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      const result = await mammoth.extractRawText({ path: filepath });
      return result.value;
    } else if (
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
}

// Helper function to call OpenAI and generate content
async function generateStudyMaterials(text, language) {
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
    // Remove markdown code fences if present
    const cleanedResponse = responseText.replace(/^```json\s*|\s*```$/g, "");

    return JSON.parse(cleanedResponse);
  } catch (error) {
    console.error("OpenAI API Error:", error);
    throw error;
  }
}

// Routes

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "AI Study Assistant API is running" });
});

// Get user info and usage
app.get("/api/user/:clerkId", async (req, res) => {
  try {
    const { clerkId } = req.params;

    let user = await prisma.user.findUnique({
      where: { clerkId },
      include: { documents: true },
    });

    if (!user) {
      // Create user if doesn't exist
      user = await prisma.user.create({
        data: {
          clerkId,
          email: req.query.email || `user-${clerkId}@example.com`,
          name: req.query.name || "User",
        },
        include: { documents: true },
      });
    }

    // Reset monthly limit if needed
    const now = new Date();
    const lastReset = new Date(user.lastReset);
    const daysSinceReset = (now - lastReset) / (1000 * 60 * 60 * 24);

    if (daysSinceReset >= 30) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          documentsUsed: 0,
          lastReset: now,
        },
        include: { documents: true },
      });
    }

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        documentsUsed: user.documentsUsed,
        monthlyLimit: user.monthlyLimit,
        remainingDocuments: user.monthlyLimit - user.documentsUsed,
      },
      documents: user.documents,
    });
  } catch (error) {
    console.error("Error fetching user:", error);
    res.status(500).json({ error: "Failed to fetch user data" });
  }
});

// Upload and process document
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const { clerkId, language } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Check user's monthly limit
    const user = await prisma.user.findUnique({ where: { clerkId } });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (user.documentsUsed >= user.monthlyLimit) {
      // Delete uploaded file
      await fs.unlink(file.path);
      return res.status(403).json({ error: "Monthly upload limit reached" });
    }

    // Extract text from file
    const text = await extractTextFromFile(file.path, file.mimetype);

    if (!text || text.trim().length < 50) {
      await fs.unlink(file.path);
      return res
        .status(400)
        .json({ error: "Could not extract enough text from file" });
    }

    // Generate study materials with OpenAI
    const studyMaterials = await generateStudyMaterials(
      text,
      language || "english",
    );

    // Save to database
    const document = await prisma.document.create({
      data: {
        userId: user.id,
        filename: file.filename,
        originalName: file.originalname,
        fileType: file.mimetype,
        fileSize: file.size,
        language: language || "english",
        summary: studyMaterials.summary,
        flashcards: studyMaterials.flashcards,
        examQuestions: studyMaterials.examQuestions,
      },
    });

    // Update user's document count
    await prisma.user.update({
      where: { id: user.id },
      data: { documentsUsed: { increment: 1 } },
    });

    // Delete the uploaded file (we've processed it)
    await fs.unlink(file.path);

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
    if (req.file) {
      await fs.unlink(req.file.path).catch(() => {});
    }
    res
      .status(500)
      .json({ error: "Failed to process document", details: error.message });
  }
});

// Get single document
app.get("/api/document/:id", async (req, res) => {
  try {
    const document = await prisma.document.findUnique({
      where: { id: req.params.id },
    });

    if (!document) {
      return res.status(404).json({ error: "Document not found" });
    }

    res.json({ document });
  } catch (error) {
    console.error("Error fetching document:", error);
    res.status(500).json({ error: "Failed to fetch document" });
  }
});

// Delete document
app.delete("/api/document/:id", async (req, res) => {
  try {
    await prisma.document.delete({
      where: { id: req.params.id },
    });

    res.json({ success: true, message: "Document deleted" });
  } catch (error) {
    console.error("Error deleting document:", error);
    res.status(500).json({ error: "Failed to delete document" });
  }
});

// Save flashcard progress
app.post("/api/flashcard/progress", async (req, res) => {
  try {
    const { userId, documentId, cardIndex, mastered } = req.body;

    const progress = await prisma.flashcardProgress.upsert({
      where: {
        userId_documentId_cardIndex: { userId, documentId, cardIndex },
      },
      update: { mastered, lastReviewed: new Date() },
      create: { userId, documentId, cardIndex, mastered },
    });

    res.json({ success: true, progress });
  } catch (error) {
    console.error("Error saving flashcard progress:", error);
    res.status(500).json({ error: "Failed to save progress" });
  }
});

// Save exam attempt
app.post("/api/exam/attempt", async (req, res) => {
  try {
    const { userId, documentId, score, totalQuestions, answers } = req.body;

    const attempt = await prisma.examAttempt.create({
      data: { userId, documentId, score, totalQuestions, answers },
    });

    res.json({ success: true, attempt });
  } catch (error) {
    console.error("Error saving exam attempt:", error);
    res.status(500).json({ error: "Failed to save exam attempt" });
  }
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`AI Study Assistant API running on port ${PORT}`);
  console.log(`Database connected`);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
