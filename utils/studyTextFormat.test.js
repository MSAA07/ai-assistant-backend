import assert from "node:assert/strict";
import test from "node:test";

import { formatStudyText } from "./studyTextFormat.js";

test("formatStudyText formats common chemical formulas without changing ordinary numbers", () => {
  assert.equal(
    formatStudyText("What is the effect of 8 cm H2O and CO2?"),
    "What is the effect of 8 cm H₂O and CO₂?",
  );
  assert.equal(formatStudyText("Question 10 of 22"), "Question 10 of 22");
});

test("formatStudyText formats simple caret exponents", () => {
  assert.equal(formatStudyText("x^2 + y^10"), "x² + y¹⁰");
});
