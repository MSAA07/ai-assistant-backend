import assert from "node:assert/strict";
import test from "node:test";

import { __studyMaterialsTestables } from "./studyMaterials.js";

test("summary cleanup normalizes headings, bullets, separators, and spacing", () => {
  const cleaned = __studyMaterialsTestables.cleanSummaryText(`
# 1. Learning Outcomes

- Explain the model
* Compare the concepts


---

## Core Concepts:

• Enterprise: scoped activity being studied
`);

  assert.equal(cleaned, [
    "## Learning Outcomes",
    "• Explain the model",
    "• Compare the concepts",
    "",
    "## Core Concepts",
    "• Enterprise: scoped activity being studied",
  ].join("\n"));
});
