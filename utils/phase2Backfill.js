import { normalizeExamQuestion, normalizeFlashcard } from "./documentGeneration.js";
import { buildPhase2RecordFromGeneration } from "./phase2GenerationRecords.js";

const LEGACY_MIGRATION_SOURCE_TYPE = "legacy_migration";

function normalizeArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeLegacyFlashcards(value) {
  return normalizeArray(value)
    .map(normalizeFlashcard)
    .filter(Boolean)
    .map((card, index) => ({
      position: index,
      question: card.question,
      answer: card.answer,
      explanation: card.explanation ?? null,
      sourceRefs: [],
    }));
}

function normalizeLegacyExamQuestions(value) {
  return normalizeArray(value)
    .map(normalizeExamQuestion)
    .filter(Boolean)
    .map((question, index) => ({
      position: index,
      questionType: question.type,
      question: question.question,
      options: Array.isArray(question.options) ? question.options : [],
      correctAnswer: question.correctAnswer,
      explanation: question.explanation,
      sourceRefs: [],
    }));
}

function asJsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function markOtherFlashcardSetsNotLatest(tx, documentId, setId) {
  await tx.flashcardSet.updateMany({
    where: {
      documentId,
      isLatest: true,
      NOT: { id: setId },
    },
    data: { isLatest: false },
  });
}

async function markOtherExamRecordsNotLatest(tx, documentId, recordId) {
  await tx.examRecord.updateMany({
    where: {
      documentId,
      isLatest: true,
      NOT: { id: recordId },
    },
    data: { isLatest: false },
  });
}

async function syncFlashcardCards(tx, setId, cards = []) {
  const positions = cards.map((card) => card.position);

  if (positions.length > 0) {
    await tx.flashcardCard.deleteMany({
      where: {
        setId,
        position: { notIn: positions },
      },
    });
  } else {
    await tx.flashcardCard.deleteMany({ where: { setId } });
  }

  for (const card of cards) {
    await tx.flashcardCard.upsert({
      where: {
        setId_position: {
          setId,
          position: card.position,
        },
      },
      update: {
        question: card.question,
        answer: card.answer,
        explanation: card.explanation ?? null,
        sourceRefs: Array.isArray(card.sourceRefs) ? card.sourceRefs : [],
        isDeleted: false,
        deletedAt: null,
      },
      create: {
        setId,
        position: card.position,
        question: card.question,
        answer: card.answer,
        explanation: card.explanation ?? null,
        sourceRefs: Array.isArray(card.sourceRefs) ? card.sourceRefs : [],
      },
    });
  }
}

async function syncExamQuestions(tx, examRecordId, questions = []) {
  const positions = questions.map((question) => question.position);

  if (positions.length > 0) {
    await tx.examQuestion.deleteMany({
      where: {
        examRecordId,
        position: { notIn: positions },
      },
    });
  } else {
    await tx.examQuestion.deleteMany({ where: { examRecordId } });
  }

  for (const question of questions) {
    await tx.examQuestion.upsert({
      where: {
        examRecordId_position: {
          examRecordId,
          position: question.position,
        },
      },
      update: {
        questionType: question.questionType,
        question: question.question,
        options: Array.isArray(question.options) ? question.options : [],
        correctAnswer: question.correctAnswer,
        explanation: question.explanation,
        sourceRefs: Array.isArray(question.sourceRefs) ? question.sourceRefs : [],
      },
      create: {
        examRecordId,
        position: question.position,
        questionType: question.questionType,
        question: question.question,
        options: Array.isArray(question.options) ? question.options : [],
        correctAnswer: question.correctAnswer,
        explanation: question.explanation,
        sourceRefs: Array.isArray(question.sourceRefs) ? question.sourceRefs : [],
      },
    });
  }
}

export async function upsertFlashcardSetWithCards(tx, {
  documentId,
  generationId = null,
  title = null,
  options = {},
  sourceType = "generation",
  isLatest = true,
  cards = [],
}) {
  const resolvedGenerationId = typeof generationId === "string" && generationId.trim()
    ? generationId.trim()
    : null;

  let existingSet = null;

  if (resolvedGenerationId) {
    existingSet = await tx.flashcardSet.findFirst({
      where: {
        documentId,
        generationId: resolvedGenerationId,
      },
      orderBy: { createdAt: "asc" },
    });
  } else if (sourceType === LEGACY_MIGRATION_SOURCE_TYPE) {
    existingSet = await tx.flashcardSet.findFirst({
      where: {
        documentId,
        sourceType: LEGACY_MIGRATION_SOURCE_TYPE,
        generationId: null,
      },
      orderBy: { createdAt: "asc" },
    });
  }

  const baseData = {
    title,
    options: asJsonObject(options),
    cardCount: cards.length,
    sourceType,
    isLatest: Boolean(isLatest),
  };

  const setRecord = existingSet
    ? await tx.flashcardSet.update({
      where: { id: existingSet.id },
      data: baseData,
    })
    : await tx.flashcardSet.create({
      data: {
        documentId,
        generationId: resolvedGenerationId,
        ...baseData,
      },
    });

  await syncFlashcardCards(tx, setRecord.id, cards);

  if (setRecord.isLatest) {
    await markOtherFlashcardSetsNotLatest(tx, documentId, setRecord.id);
  }

  return setRecord;
}

export async function upsertExamRecordWithQuestions(tx, {
  documentId,
  generationId = null,
  title = null,
  options = {},
  sourceType = "generation",
  isLatest = true,
  questions = [],
}) {
  const resolvedGenerationId = typeof generationId === "string" && generationId.trim()
    ? generationId.trim()
    : null;

  let existingRecord = null;

  if (resolvedGenerationId) {
    existingRecord = await tx.examRecord.findFirst({
      where: {
        documentId,
        generationId: resolvedGenerationId,
      },
      orderBy: { createdAt: "asc" },
    });
  } else if (sourceType === LEGACY_MIGRATION_SOURCE_TYPE) {
    existingRecord = await tx.examRecord.findFirst({
      where: {
        documentId,
        sourceType: LEGACY_MIGRATION_SOURCE_TYPE,
        generationId: null,
      },
      orderBy: { createdAt: "asc" },
    });
  }

  const baseData = {
    title,
    options: asJsonObject(options),
    questionCount: questions.length,
    sourceType,
    isLatest: Boolean(isLatest),
  };

  const examRecord = existingRecord
    ? await tx.examRecord.update({
      where: { id: existingRecord.id },
      data: baseData,
    })
    : await tx.examRecord.create({
      data: {
        documentId,
        generationId: resolvedGenerationId,
        ...baseData,
      },
    });

  await syncExamQuestions(tx, examRecord.id, questions);

  if (examRecord.isLatest) {
    await markOtherExamRecordsNotLatest(tx, documentId, examRecord.id);
  }

  return examRecord;
}

export async function upsertCanonicalGenerationRecord(tx, {
  generationType,
  documentId,
  generationId = null,
  options = {},
  output = {},
  isLatest = true,
}) {
  const builtRecord = buildPhase2RecordFromGeneration({
    generationType,
    documentId,
    generationId,
    options,
    output,
  });

  if (!builtRecord) {
    return null;
  }

  if (builtRecord.type === "flashcards") {
    const set = await upsertFlashcardSetWithCards(tx, {
      documentId,
      generationId,
      title: builtRecord.set.title,
      options: builtRecord.set.options,
      sourceType: builtRecord.set.sourceType,
      isLatest,
      cards: builtRecord.cards,
    });

    return { type: "flashcards", setId: set.id };
  }

  const examRecord = await upsertExamRecordWithQuestions(tx, {
    documentId,
    generationId,
    title: builtRecord.record.title,
    options: builtRecord.record.options,
    sourceType: builtRecord.record.sourceType,
    isLatest,
    questions: builtRecord.questions,
  });

  return { type: "exam", examRecordId: examRecord.id };
}

export async function backfillLegacyDocumentFlashcards(tx, document) {
  const cards = normalizeLegacyFlashcards(document?.flashcards);

  if (cards.length === 0) {
    return null;
  }

  return upsertFlashcardSetWithCards(tx, {
    documentId: document.id,
    generationId: null,
    options: {
      migrationKey: "legacy_flashcards_v1",
    },
    sourceType: LEGACY_MIGRATION_SOURCE_TYPE,
    isLatest: true,
    cards,
  });
}

export async function backfillLegacyDocumentExam(tx, document) {
  const questions = normalizeLegacyExamQuestions(document?.examQuestions);

  if (questions.length === 0) {
    return null;
  }

  return upsertExamRecordWithQuestions(tx, {
    documentId: document.id,
    generationId: null,
    options: {
      migrationKey: "legacy_exam_v1",
    },
    sourceType: LEGACY_MIGRATION_SOURCE_TYPE,
    isLatest: true,
    questions,
  });
}

export async function backfillLegacyFlashcardProgress(tx, {
  documentId,
  migratedSetId,
}) {
  if (!migratedSetId) {
    return { mapped: 0, skipped: 0 };
  }

  const [cards, progressRows] = await Promise.all([
    tx.flashcardCard.findMany({
      where: {
        setId: migratedSetId,
        isDeleted: false,
      },
      select: {
        id: true,
        position: true,
      },
    }),
    tx.flashcardProgress.findMany({
      where: { documentId },
      select: {
        userId: true,
        cardIndex: true,
        mastered: true,
        lastReviewed: true,
      },
    }),
  ]);

  const cardIdByPosition = new Map(cards.map((card) => [card.position, card.id]));
  let mapped = 0;
  let skipped = 0;

  for (const row of progressRows) {
    const cardId = cardIdByPosition.get(row.cardIndex);

    if (!cardId) {
      skipped += 1;
      continue;
    }

    await tx.flashcardCardState.upsert({
      where: {
        userId_cardId: {
          userId: row.userId,
          cardId,
        },
      },
      update: {
        mastered: Boolean(row.mastered),
        lastReviewedAt: row.lastReviewed ?? null,
        lastResult: row.mastered ? "correct" : "unseen",
      },
      create: {
        userId: row.userId,
        cardId,
        mastered: Boolean(row.mastered),
        lastReviewedAt: row.lastReviewed ?? null,
        lastResult: row.mastered ? "correct" : "unseen",
      },
    });

    mapped += 1;
  }

  return { mapped, skipped };
}

export async function linkLegacyExamAttempts(tx, {
  documentId,
  migratedExamRecordId,
}) {
  if (!migratedExamRecordId) {
    return 0;
  }

  const updateResult = await tx.examAttempt.updateMany({
    where: {
      documentId,
      OR: [
        { examRecordId: null },
        { examRecordId: migratedExamRecordId },
      ],
    },
    data: {
      examRecordId: migratedExamRecordId,
      status: "submitted",
    },
  });

  return updateResult.count;
}

function canonicalizeFlashcard(card) {
  return {
    question: typeof card?.question === "string" ? card.question.trim() : "",
    answer: typeof card?.answer === "string" ? card.answer.trim() : "",
    explanation: typeof card?.explanation === "string" ? card.explanation.trim() : "",
  };
}

function canonicalizeExamQuestion(question) {
  const options = Array.isArray(question?.options)
    ? question.options.map((option) => (typeof option === "string" ? option.trim() : "")).filter(Boolean)
    : [];

  return {
    type: typeof question?.type === "string" ? question.type.trim().toLowerCase() : "",
    question: typeof question?.question === "string" ? question.question.trim() : "",
    correctAnswer: typeof question?.correctAnswer === "string" ? question.correctAnswer.trim() : "",
    explanation: typeof question?.explanation === "string" ? question.explanation.trim() : "",
    options,
  };
}

export async function runPhase2BackfillReconciliation(prisma) {
  const mismatches = [];

  const documents = await prisma.document.findMany({
    select: {
      id: true,
      flashcards: true,
      examQuestions: true,
      flashcardSets: {
        where: {
          sourceType: LEGACY_MIGRATION_SOURCE_TYPE,
          generationId: null,
        },
        include: {
          cards: {
            where: { isDeleted: false },
            orderBy: { position: "asc" },
          },
        },
        orderBy: { createdAt: "asc" },
      },
      examRecords: {
        where: {
          sourceType: LEGACY_MIGRATION_SOURCE_TYPE,
          generationId: null,
        },
        include: {
          questions: {
            orderBy: { position: "asc" },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  for (const document of documents) {
    const legacyFlashcards = normalizeLegacyFlashcards(document.flashcards);
    const migratedFlashcards = (document.flashcardSets[0]?.cards ?? []).map((card) => ({
      question: card.question,
      answer: card.answer,
      explanation: card.explanation ?? "",
    })).map(canonicalizeFlashcard);

    const expectedFlashcards = legacyFlashcards.map((card) => canonicalizeFlashcard(card));

    if (legacyFlashcards.length > 0 && document.flashcardSets.length === 0) {
      mismatches.push(`document ${document.id}: missing migrated flashcard set`);
    } else if (JSON.stringify(expectedFlashcards) !== JSON.stringify(migratedFlashcards)) {
      mismatches.push(`document ${document.id}: flashcard mirror mismatch`);
    }

    const legacyExamQuestions = normalizeLegacyExamQuestions(document.examQuestions);
    const migratedExamQuestions = (document.examRecords[0]?.questions ?? []).map((question) => ({
      type: question.questionType,
      question: question.question,
      options: Array.isArray(question.options) ? question.options : [],
      correctAnswer: question.correctAnswer,
      explanation: question.explanation,
    })).map(canonicalizeExamQuestion);

    const expectedExamQuestions = legacyExamQuestions.map((question) => canonicalizeExamQuestion({
      type: question.questionType,
      question: question.question,
      options: question.options,
      correctAnswer: question.correctAnswer,
      explanation: question.explanation,
    }));

    if (legacyExamQuestions.length > 0 && document.examRecords.length === 0) {
      mismatches.push(`document ${document.id}: missing migrated exam record`);
    } else if (JSON.stringify(expectedExamQuestions) !== JSON.stringify(migratedExamQuestions)) {
      mismatches.push(`document ${document.id}: exam mirror mismatch`);
    }
  }

  const progressRows = await prisma.flashcardProgress.findMany({
    select: {
      id: true,
      userId: true,
      documentId: true,
      cardIndex: true,
      mastered: true,
    },
  });

  for (const row of progressRows) {
    const migratedSet = await prisma.flashcardSet.findFirst({
      where: {
        documentId: row.documentId,
        sourceType: LEGACY_MIGRATION_SOURCE_TYPE,
        generationId: null,
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });

    if (!migratedSet) {
      continue;
    }

    const card = await prisma.flashcardCard.findFirst({
      where: {
        setId: migratedSet.id,
        position: row.cardIndex,
      },
      select: { id: true },
    });

    if (!card) {
      mismatches.push(`progress ${row.id}: no migrated card at position ${row.cardIndex}`);
      continue;
    }

    const state = await prisma.flashcardCardState.findUnique({
      where: {
        userId_cardId: {
          userId: row.userId,
          cardId: card.id,
        },
      },
      select: {
        mastered: true,
      },
    });

    if (!state) {
      mismatches.push(`progress ${row.id}: missing card state mapping`);
      continue;
    }

    if (Boolean(state.mastered) !== Boolean(row.mastered)) {
      mismatches.push(`progress ${row.id}: mastered mismatch`);
    }
  }

  const attempts = await prisma.examAttempt.findMany({
    where: {
      examRecordId: { not: null },
    },
    select: {
      id: true,
      documentId: true,
      examRecordId: true,
      totalQuestions: true,
      status: true,
      examRecord: {
        select: {
          id: true,
          documentId: true,
          questionCount: true,
          sourceType: true,
        },
      },
    },
  });

  for (const attempt of attempts) {
    const record = attempt.examRecord;

    if (!record) {
      mismatches.push(`attempt ${attempt.id}: missing examRecord relation`);
      continue;
    }

    if (record.documentId !== attempt.documentId) {
      mismatches.push(`attempt ${attempt.id}: document mismatch against examRecord`);
    }

    if (record.sourceType === LEGACY_MIGRATION_SOURCE_TYPE && attempt.status !== "submitted") {
      mismatches.push(`attempt ${attempt.id}: migrated attempt status is not submitted`);
    }

    if (record.sourceType === LEGACY_MIGRATION_SOURCE_TYPE && Number(attempt.totalQuestions) !== Number(record.questionCount)) {
      mismatches.push(`attempt ${attempt.id}: totalQuestions mismatch against migrated examRecord`);
    }
  }

  return {
    ok: mismatches.length === 0,
    mismatchCount: mismatches.length,
    mismatches,
  };
}

export { LEGACY_MIGRATION_SOURCE_TYPE };
