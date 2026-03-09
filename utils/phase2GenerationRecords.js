import { buildFlashcardSetFromGeneration } from "./phase2Flashcards.js";
import { buildExamRecordFromGeneration } from "./phase2Exams.js";

export function buildPhase2RecordFromGeneration({
  generationType,
  documentId,
  generationId = null,
  options = {},
  output = {},
}) {
  if (generationType === "flashcards") {
    return {
      type: "flashcards",
      ...buildFlashcardSetFromGeneration({
        documentId,
        generationId,
        options,
        output,
      }),
    };
  }

  if (generationType === "exam") {
    return {
      type: "exam",
      ...buildExamRecordFromGeneration({
        documentId,
        generationId,
        options,
        output,
      }),
    };
  }

  return null;
}

