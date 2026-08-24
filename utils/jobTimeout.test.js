import assert from "node:assert/strict";
import test from "node:test";

import { runWithAbortableTimeout } from "./jobTimeout.js";

test("job timeout aborts the in-flight task before returning the timeout failure", async () => {
  let abortObserved = false;
  let workCompleted = false;

  await assert.rejects(
    () => runWithAbortableTimeout((signal) => new Promise((resolve, reject) => {
      const workTimer = setTimeout(() => {
        workCompleted = true;
        resolve("late billable result");
      }, 200);

      signal.addEventListener("abort", () => {
        abortObserved = true;
        clearTimeout(workTimer);
        const abortError = new Error("provider request aborted");
        abortError.name = "AbortError";
        reject(abortError);
      }, { once: true });
    }), 10),
    (error) => error?.code === "job_timeout" && /10ms/.test(error.message),
  );

  assert.equal(abortObserved, true);
  assert.equal(workCompleted, false);
});
