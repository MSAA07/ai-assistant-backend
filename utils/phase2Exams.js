import { normalizeCompactSourceRefs } from "./phase2SourceRefs.js";

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOptions(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const unique = [];
  for (const option of value) {
    const normalized = normalizeString(option);
    if (!normalized || unique.includes(normalized)) {
      continue;
    }
    unique.push(normalized);
  }

  return unique;
}

export function normalizeExamRecordInput(input = {}) {
  return {
    documentId: normalizeString(input.documentId),
    generationId: normalizeString(input.generationId) || null,
    title: normalizeString(input.title) || null,
    options: input.options && typeof input.options === "object" && !Array.isArray(input.options)
      ? input.options
      : {},
    sourceType: normalizeString(input.sourceType) || "generation",
    isLatest: Boolean(input.isLatest),
  };
}

export function normalizeExamQuestionInput(question = {}) {
  const questionType = normalizeString(question.questionType ?? question.type).toLowerCase();
  const prompt = normalizeString(question.question);
  const correctAnswer = normalizeString(question.correctAnswer);
  const explanation = normalizeString(question.explanation);
  const options = normalizeOptions(question.options);

  if (!questionType || !prompt || !correctAnswer || !explanation) {
    return null;
  }

  return {
    questionType,
    question: prompt,
    options,
    correctAnswer,
    explanation,
    sourceRefs: normalizeCompactSourceRefs(question.sourceRefs),
  };
}

export function buildExamRecordFromGeneration({
  documentId,
  generationId = null,
  options = {},
  output = {},
}) {
  const questions = Array.isArray(output?.questions)
    ? output.questions.map(normalizeExamQuestionInput).filter(Boolean)
    : [];

  return {
    record: normalizeExamRecordInput({
      documentId,
      generationId,
      options,
      sourceType: "generation",
      isLatest: true,
    }),
    questions: questions.map((question, index) => ({
      position: index,
      ...question,
    })),
  };
}

export function serializeExamRecord(record, questions = []) {
  return {
    id: record?.id ?? null,
    documentId: record?.documentId ?? null,
    generationId: record?.generationId ?? null,
    title: record?.title ?? null,
    options: record?.options ?? {},
    questionCount: Number(record?.questionCount ?? questions.length ?? 0),
    sourceType: record?.sourceType ?? "generation",
    isLatest: Boolean(record?.isLatest),
    createdAt: record?.createdAt ?? null,
    updatedAt: record?.updatedAt ?? null,
    questions: questions.map((question) => ({
      id: question.id,
      position: question.position,
      questionType: question.questionType,
      question: question.question,
      options: Array.isArray(question.options) ? question.options : [],
      correctAnswer: question.correctAnswer,
      explanation: question.explanation,
      sourceRefs: Array.isArray(question.sourceRefs) ? question.sourceRefs : [],
    })),
  };
}

