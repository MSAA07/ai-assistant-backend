import { normalizeCompactSourceRefs } from "./phase2SourceRefs.js";

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBoolean(value) {
  return Boolean(value);
}

export function normalizeFlashcardSetInput(input = {}) {
  return {
    documentId: normalizeString(input.documentId),
    generationId: normalizeString(input.generationId) || null,
    title: normalizeString(input.title) || null,
    options: input.options && typeof input.options === "object" && !Array.isArray(input.options)
      ? input.options
      : {},
    sourceType: normalizeString(input.sourceType) || "generation",
    isLatest: normalizeBoolean(input.isLatest),
  };
}

export function normalizeFlashcardCardInput(card = {}) {
  const question = normalizeString(card.question);
  const answer = normalizeString(card.answer);
  const explanation = normalizeString(card.explanation);

  if (!question || !answer) {
    return null;
  }

  return {
    question,
    answer,
    explanation: explanation || null,
    sourceRefs: normalizeCompactSourceRefs(card.sourceRefs),
  };
}

export function buildFlashcardSetFromGeneration({
  documentId,
  generationId = null,
  options = {},
  output = {},
}) {
  const cards = Array.isArray(output?.cards)
    ? output.cards.map(normalizeFlashcardCardInput).filter(Boolean)
    : [];

  return {
    set: normalizeFlashcardSetInput({
      documentId,
      generationId,
      options,
      sourceType: "generation",
      isLatest: true,
    }),
    cards: cards.map((card, index) => ({
      position: index,
      ...card,
    })),
  };
}

export function serializeFlashcardSet(setRecord, cards = [], cardStates = []) {
  return {
    id: setRecord?.id ?? null,
    documentId: setRecord?.documentId ?? null,
    generationId: setRecord?.generationId ?? null,
    title: setRecord?.title ?? null,
    options: setRecord?.options ?? {},
    cardCount: Number(setRecord?.cardCount ?? cards.length ?? 0),
    sourceType: setRecord?.sourceType ?? "generation",
    isLatest: Boolean(setRecord?.isLatest),
    createdAt: setRecord?.createdAt ?? null,
    updatedAt: setRecord?.updatedAt ?? null,
    cards: cards.map((card) => ({
      id: card.id,
      position: card.position,
      question: card.question,
      answer: card.answer,
      explanation: card.explanation ?? null,
      sourceRefs: Array.isArray(card.sourceRefs) ? card.sourceRefs : [],
      isDeleted: Boolean(card.isDeleted),
      deletedAt: card.deletedAt ?? null,
      state: cardStates.find((state) => state.cardId === card.id) ?? null,
    })),
  };
}

