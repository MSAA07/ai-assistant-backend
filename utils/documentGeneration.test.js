import assert from "node:assert/strict";
import test from "node:test";

import { normalizeExamQuestion } from "./documentGeneration.js";

test("normalizeExamQuestion accepts boolean true false answers", () => {
  assert.deepEqual(
    normalizeExamQuestion({
      type: "true_false",
      question: "Enterprise Architecture only concerns software systems.",
      correctAnswer: false,
      explanation: "EA also covers people, processes, structure, and strategy.",
    }),
    {
      type: "true_false",
      question: "Enterprise Architecture only concerns software systems.",
      correctAnswer: "False",
      explanation: "EA also covers people, processes, structure, and strategy.",
    },
  );
});
