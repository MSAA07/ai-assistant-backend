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

function normalizeQuestionType(value) {
  const questionType = normalizeString(value).toLowerCase();
  if (questionType === "mcq" || questionType === "multiple_choice") {
    return "mcq";
  }
  if (questionType === "true_false" || questionType === "truefalse") {
    return "true_false";
  }
  return "";
}

function normalizeCorrectAnswer(value, questionType) {
  const answer = normalizeString(value);
  if (questionType !== "true_false") {
    return answer;
  }

  const normalized = answer.toLowerCase();
  if (normalized === "true") return "True";
  if (normalized === "false") return "False";
  return "";
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
  const questionType = normalizeQuestionType(question.questionType ?? question.type);
  const prompt = normalizeString(question.question);
  const correctAnswer = normalizeCorrectAnswer(question.correctAnswer, questionType);
  const explanation = normalizeString(question.explanation);
  const options = normalizeOptions(question.options);

  if (!questionType || !prompt || !correctAnswer || !explanation) {
    return null;
  }

  if (questionType === "mcq" && (options.length < 2 || !options.includes(correctAnswer))) {
    return null;
  }

  if (questionType === "true_false" && options.length > 0) {
    return {
      questionType,
      question: prompt,
      options: [],
      correctAnswer,
      explanation,
      sourceRefs: normalizeCompactSourceRefs(question.sourceRefs),
    };
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

export function normalizeStoredExamQuestions(questions = []) {
  return Array.isArray(questions)
    ? questions.map(normalizeExamQuestionInput).filter(Boolean)
    : [];
}

export function serializeExamRecord(record, questions = []) {
  const normalizedQuestions = normalizeStoredExamQuestions(questions);

  return {
    id: record?.id ?? null,
    documentId: record?.documentId ?? null,
    generationId: record?.generationId ?? null,
    title: record?.title ?? null,
    options: record?.options ?? {},
    questionCount: normalizedQuestions.length,
    sourceType: record?.sourceType ?? "generation",
    isLatest: Boolean(record?.isLatest),
    createdAt: record?.createdAt ?? null,
    updatedAt: record?.updatedAt ?? null,
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
  };
}
