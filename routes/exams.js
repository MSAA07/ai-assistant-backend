import express from "express";

import { captureSentryException } from "../utils/sentry.js";
import { LEGACY_MIGRATION_SOURCE_TYPE } from "../utils/phase2Backfill.js";
import { normalizeStoredExamQuestions, serializeExamRecord } from "../utils/phase2Exams.js";
import { normalizePositiveInteger, getOwnedDocument, getOwnedExamRecord } from "../utils/routeHelpers.js";

function normalizeAnswerValue(value) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }

  return "";
}

function normalizeComparableAnswer(value, questionType) {
  const normalized = normalizeAnswerValue(value).toLowerCase();

  if (questionType === "true_false") {
    if (normalized === "true" || normalized === "t") {
      return "true";
    }
    if (normalized === "false" || normalized === "f") {
      return "false";
    }
  }

  return normalized;
}

function toAnswerLookup(answers) {
  const lookup = {
    byQuestionId: new Map(),
    byPosition: new Map(),
  };

  if (Array.isArray(answers)) {
    for (const entry of answers) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const value = normalizeAnswerValue(entry.answer ?? entry.value ?? entry.selectedAnswer);
      if (!value) {
        continue;
      }

      if (typeof entry.questionId === "string" && entry.questionId.trim()) {
        lookup.byQuestionId.set(entry.questionId.trim(), value);
      }

      const rawPosition = Number(entry.position ?? entry.questionIndex ?? entry.index);
      if (Number.isFinite(rawPosition)) {
        lookup.byPosition.set(rawPosition, value);
      }
    }

    return lookup;
  }

  if (answers && typeof answers === "object") {
    for (const [key, value] of Object.entries(answers)) {
      const normalized = normalizeAnswerValue(value);
      if (!normalized) {
        continue;
      }

      const numericKey = Number(key);
      if (Number.isFinite(numericKey)) {
        lookup.byPosition.set(numericKey, normalized);
      } else {
        lookup.byQuestionId.set(key, normalized);
      }
    }
  }

  return lookup;
}

function calculateExamScore(questions, answers) {
  const lookup = toAnswerLookup(answers);
  let score = 0;

  for (const question of questions) {
    const provided = lookup.byQuestionId.get(question.id)
      ?? lookup.byPosition.get(question.position)
      ?? "";

    if (!provided) {
      continue;
    }

    const left = normalizeComparableAnswer(provided, question.questionType);
    const right = normalizeComparableAnswer(question.correctAnswer, question.questionType);

    if (left && right && left === right) {
      score += 1;
    }
  }

  return {
    score,
    totalQuestions: questions.length,
  };
}


async function getOwnedExamAttempt(prisma, attemptId, userId) {
  const attempt = await prisma.examAttempt.findUnique({
    where: { id: attemptId },
    include: {
      examRecord: {
        select: {
          id: true,
          documentId: true,
          document: {
            select: { userId: true },
          },
        },
      },
    },
  });

  if (!attempt) {
    return { status: 404, error: "Attempt not found" };
  }

  if (attempt.userId !== userId) {
    return { status: 403, error: "Access denied" };
  }

  if (!attempt.examRecord || attempt.examRecord.document.userId !== userId) {
    return { status: 404, error: "Exam not found" };
  }

  return { attempt };
}

export const createExamsRouter = ({ prisma, requireAuth }) => {
  const router = express.Router();

  router.post("/attempt", requireAuth, async (req, res) => {
    try {
      const { documentId, score, totalQuestions, answers } = req.body;
      const parsedScore = Number(score);
      const parsedTotal = Number(totalQuestions);

      if (!documentId || Number.isNaN(parsedScore) || Number.isNaN(parsedTotal)) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const document = await prisma.document.findUnique({
        where: { id: documentId },
        select: { userId: true },
      });

      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }

      if (document.userId !== req.session.user.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      const attempt = await prisma.$transaction(async (tx) => {
        const latestExamRecord = await tx.examRecord.findFirst({
          where: {
            documentId,
            isLatest: true,
          },
          select: { id: true },
          orderBy: { createdAt: "desc" },
        });

        const migratedExamRecord = latestExamRecord ?? await tx.examRecord.findFirst({
          where: {
            documentId,
            sourceType: LEGACY_MIGRATION_SOURCE_TYPE,
            generationId: null,
          },
          select: { id: true },
          orderBy: { createdAt: "asc" },
        });

        return tx.examAttempt.create({
          data: {
            userId: req.session.user.id,
            documentId,
            examRecordId: migratedExamRecord?.id ?? null,
            score: parsedScore,
            totalQuestions: parsedTotal,
            answers,
            status: "submitted",
          },
        });
      });

      res.json({ success: true, attempt });
    } catch (error) {
      console.error("Error saving exam attempt:", error);
      captureSentryException(error);
      res.status(500).json({ error: "Failed to save exam attempt" });
    }
  });

  return router;
};

export const createCanonicalExamsRouter = ({ prisma, requireAuth }) => {
  const router = express.Router();

  router.get("/document/:id/exams", requireAuth, async (req, res) => {
    try {
      const ownership = await getOwnedDocument(prisma, req.params.id, req.session.user.id);
      if (ownership.error) {
        return res.status(ownership.status).json({ error: ownership.error });
      }

      const page = normalizePositiveInteger(req.query?.page, 1, { min: 1, max: 10_000 });
      const limit = normalizePositiveInteger(req.query?.limit, 20, { min: 1, max: 100 });
      const skip = (page - 1) * limit;

      const where = { documentId: req.params.id };
      const [total, exams] = await Promise.all([
        prisma.examRecord.count({ where }),
        prisma.examRecord.findMany({
          where,
          orderBy: [{ createdAt: "desc" }],
          skip,
          take: limit,
          include: {
            questions: {
              orderBy: [{ position: "asc" }],
            },
          },
        }),
      ]);

      return res.json({
        documentId: req.params.id,
        exams: exams.map((exam) => ({
          id: exam.id,
          title: exam.title,
          questionCount: normalizeStoredExamQuestions(exam.questions).length,
          generationId: exam.generationId,
          createdAt: exam.createdAt,
        })),
        pagination: {
          page,
          limit,
          total,
          hasMore: skip + exams.length < total,
        },
      });
    } catch (error) {
      console.error("Error listing exams:", error);
      captureSentryException(error, {
        tags: { route: "exams", action: "list" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
      });
      return res.status(500).json({ error: "Failed to list exams" });
    }
  });

  router.get("/exams/:examId", requireAuth, async (req, res) => {
    try {
      const ownership = await getOwnedExamRecord(prisma, req.params.examId, req.session.user.id);
      if (ownership.error) {
        return res.status(ownership.status).json({ error: ownership.error });
      }

      const questions = await prisma.examQuestion.findMany({
        where: { examRecordId: ownership.examRecord.id },
        orderBy: [{ position: "asc" }],
      });

      return res.json({
        exam: serializeExamRecord(ownership.examRecord, normalizeStoredExamQuestions(questions)),
      });
    } catch (error) {
      console.error("Error fetching exam:", error);
      captureSentryException(error, {
        tags: { route: "exams", action: "fetch" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
      });
      return res.status(500).json({ error: "Failed to fetch exam" });
    }
  });

  router.post("/exams/:examId/attempts", requireAuth, async (req, res) => {
    try {
      const ownership = await getOwnedExamRecord(prisma, req.params.examId, req.session.user.id);
      if (ownership.error) {
        return res.status(ownership.status).json({ error: ownership.error });
      }

      const now = new Date();
      const questions = await prisma.examQuestion.findMany({
        where: { examRecordId: ownership.examRecord.id },
        orderBy: [{ position: "asc" }],
      });
      const normalizedQuestions = normalizeStoredExamQuestions(questions);
      const attempt = await prisma.examAttempt.create({
        data: {
          userId: req.session.user.id,
          documentId: ownership.examRecord.documentId,
          examRecordId: ownership.examRecord.id,
          score: 0,
          totalQuestions: normalizedQuestions.length,
          answers: req.body?.answers ?? [],
          status: "in_progress",
          startedAt: now,
          lastSavedAt: now,
          submittedAt: null,
          completedAt: now,
          feedbackMode: req.body?.feedbackMode === "instant" ? "instant" : "end",
        },
      });

      return res.status(201).json({ success: true, attempt });
    } catch (error) {
      console.error("Error creating exam attempt:", error);
      captureSentryException(error, {
        tags: { route: "exams", action: "create_attempt" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
      });
      return res.status(500).json({ error: "Failed to create exam attempt" });
    }
  });

  router.get("/exams/:examId/attempts/current", requireAuth, async (req, res) => {
    try {
      const ownership = await getOwnedExamRecord(prisma, req.params.examId, req.session.user.id);
      if (ownership.error) {
        return res.status(ownership.status).json({ error: ownership.error });
      }

      const attempt = await prisma.examAttempt.findFirst({
        where: {
          userId: req.session.user.id,
          examRecordId: ownership.examRecord.id,
          status: "in_progress",
        },
        orderBy: [{ startedAt: "desc" }],
      });

      return res.json({ attempt: attempt ?? null });
    } catch (error) {
      console.error("Error getting current exam attempt:", error);
      captureSentryException(error, {
        tags: { route: "exams", action: "current_attempt" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
      });
      return res.status(500).json({ error: "Failed to fetch current attempt" });
    }
  });

  router.post("/exam-attempts/:attemptId/save", requireAuth, async (req, res) => {
    try {
      const ownedAttempt = await getOwnedExamAttempt(prisma, req.params.attemptId, req.session.user.id);
      if (ownedAttempt.error) {
        return res.status(ownedAttempt.status).json({ error: ownedAttempt.error });
      }

      const attempt = ownedAttempt.attempt;
      if (attempt.status !== "in_progress") {
        return res.status(409).json({ error: "Attempt is not in progress" });
      }

      const updatedAttempt = await prisma.examAttempt.update({
        where: { id: attempt.id },
        data: {
          answers: req.body?.answers ?? attempt.answers,
          lastSavedAt: new Date(),
        },
      });

      return res.json({ success: true, attempt: updatedAttempt });
    } catch (error) {
      console.error("Error saving exam attempt:", error);
      captureSentryException(error, {
        tags: { route: "exams", action: "save_attempt" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
      });
      return res.status(500).json({ error: "Failed to save attempt" });
    }
  });

  router.post("/exam-attempts/:attemptId/submit", requireAuth, async (req, res) => {
    try {
      const ownedAttempt = await getOwnedExamAttempt(prisma, req.params.attemptId, req.session.user.id);
      if (ownedAttempt.error) {
        return res.status(ownedAttempt.status).json({ error: ownedAttempt.error });
      }

      const attempt = ownedAttempt.attempt;
      if (attempt.status !== "in_progress") {
        return res.status(409).json({ error: "Attempt is already submitted" });
      }

      const questions = await prisma.examQuestion.findMany({
        where: { examRecordId: attempt.examRecordId },
        orderBy: [{ position: "asc" }],
      });
      const normalizedQuestions = normalizeStoredExamQuestions(questions);

      const answers = req.body?.answers ?? attempt.answers;
      const scoring = calculateExamScore(normalizedQuestions, answers);
      const now = new Date();

      const submittedAttempt = await prisma.examAttempt.update({
        where: { id: attempt.id },
        data: {
          answers,
          score: scoring.score,
          totalQuestions: scoring.totalQuestions,
          status: "submitted",
          submittedAt: now,
          lastSavedAt: now,
          completedAt: now,
        },
      });

      return res.json({
        success: true,
        attempt: submittedAttempt,
        result: {
          score: scoring.score,
          totalQuestions: scoring.totalQuestions,
        },
      });
    } catch (error) {
      console.error("Error submitting exam attempt:", error);
      captureSentryException(error, {
        tags: { route: "exams", action: "submit_attempt" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
      });
      return res.status(500).json({ error: "Failed to submit attempt" });
    }
  });

  router.post("/exam-attempts/:attemptId/restart", requireAuth, async (req, res) => {
    try {
      const ownedAttempt = await getOwnedExamAttempt(prisma, req.params.attemptId, req.session.user.id);
      if (ownedAttempt.error) {
        return res.status(ownedAttempt.status).json({ error: ownedAttempt.error });
      }

      const attempt = ownedAttempt.attempt;
      const now = new Date();
      const restartedAttempt = await prisma.examAttempt.create({
        data: {
          userId: req.session.user.id,
          documentId: attempt.documentId,
          examRecordId: attempt.examRecordId,
          score: 0,
          totalQuestions: attempt.totalQuestions,
          answers: [],
          status: "in_progress",
          startedAt: now,
          lastSavedAt: now,
          submittedAt: null,
          completedAt: now,
          feedbackMode: attempt.feedbackMode,
          restartFromAttemptId: attempt.id,
        },
      });

      return res.status(201).json({ success: true, attempt: restartedAttempt });
    } catch (error) {
      console.error("Error restarting exam attempt:", error);
      captureSentryException(error, {
        tags: { route: "exams", action: "restart_attempt" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
      });
      return res.status(500).json({ error: "Failed to restart attempt" });
    }
  });

  router.get("/exam-attempts/:attemptId/review", requireAuth, async (req, res) => {
    try {
      const ownedAttempt = await getOwnedExamAttempt(prisma, req.params.attemptId, req.session.user.id);
      if (ownedAttempt.error) {
        return res.status(ownedAttempt.status).json({ error: ownedAttempt.error });
      }

      const attempt = ownedAttempt.attempt;
      const questions = await prisma.examQuestion.findMany({
        where: { examRecordId: attempt.examRecordId },
        orderBy: [{ position: "asc" }],
      });
      const normalizedQuestions = normalizeStoredExamQuestions(questions);

      return res.json({
        attempt,
        review: {
          questions: normalizedQuestions.map((question) => ({
            id: question.id,
            position: question.position,
            questionType: question.questionType,
            question: question.question,
            options: Array.isArray(question.options) ? question.options : [],
            correctAnswer: question.correctAnswer,
            explanation: question.explanation,
            sourceRefs: Array.isArray(question.sourceRefs) ? question.sourceRefs : [],
          })),
          answers: attempt.answers,
          score: attempt.score,
          totalQuestions: attempt.totalQuestions,
        },
      });
    } catch (error) {
      console.error("Error reviewing exam attempt:", error);
      captureSentryException(error, {
        tags: { route: "exams", action: "review_attempt" },
        user: req.session?.user?.id ? { id: req.session.user.id } : undefined,
      });
      return res.status(500).json({ error: "Failed to review attempt" });
    }
  });

  return router;
};
