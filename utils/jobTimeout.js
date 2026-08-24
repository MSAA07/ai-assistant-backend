const DEFAULT_ABORT_SETTLE_GRACE_MS = 1_000;

export function createJobTimeoutError(timeoutMs) {
  const error = new Error(`Job timed out after ${timeoutMs}ms`);
  error.code = "job_timeout";
  return error;
}

async function waitForAbortSettlement(taskPromise, graceMs) {
  let graceHandle;
  try {
    await Promise.race([
      taskPromise.then(
        () => undefined,
        () => undefined,
      ),
      new Promise((resolve) => {
        graceHandle = setTimeout(resolve, graceMs);
      }),
    ]);
  } finally {
    clearTimeout(graceHandle);
  }
}

export async function runWithAbortableTimeout(
  task,
  timeoutMs,
  { abortSettleGraceMs = DEFAULT_ABORT_SETTLE_GRACE_MS } = {},
) {
  const controller = new AbortController();
  const timeoutError = createJobTimeoutError(timeoutMs);
  let timeoutHandle;
  let didTimeout = false;

  const taskPromise = Promise.resolve().then(() => task(controller.signal));
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      didTimeout = true;
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([taskPromise, timeoutPromise]);
  } catch (error) {
    if (!didTimeout) {
      throw error;
    }

    await waitForAbortSettlement(taskPromise, abortSettleGraceMs);
    throw timeoutError;
  } finally {
    clearTimeout(timeoutHandle);
  }
}
