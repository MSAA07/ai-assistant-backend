import {
  DOCUMENT_GENERATION_TYPES,
  getFeatureKeyForGenerationType,
  getGenerationTypeForJobType,
  getUsageEventTypeForGenerationType,
  isUsableGenerationExcerpt,
  normalizeGenerationOptions,
  sortGenerationExcerpts,
} from "./documentGeneration.js";
import { updateJobProgress } from "./jobQueue.js";
import { withJobStage } from "./jobStageEvents.js";
import {
  assertCanStartGeneration,
  checkAndIncrementDailyTokenCap,
  ensureUserLimitExists,
} from "./limits.js";
import { recordUsageEvent } from "./costGuard.js";
import {
  generateStudyMaterialFromExcerpts,
  prepareGpt55SummarySourceMaterial,
  prepareGenerationSourceMaterial,
} from "./studyMaterials.js";

function createNonRetryableError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function getPromptTokenUsage(usage) {
  return Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0);
}

function getCompletionTokenUsage(usage) {
  return Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0);
}

export async function processGeneration(prisma, job, workerId, { signal } = {}) {
  const generationType = getGenerationTypeForJobType(job.jobType);
  const documentId = job.documentId ?? job.payload?.documentId;
  const generationId = job.payload?.generationId;

  if (!generationType) {
    throw createNonRetryableError(`Unsupported generation job type: ${job.jobType}`, "invalid_generation_job");
  }

  if (!documentId) {
    throw createNonRetryableError(`Job ${job.id} is missing a documentId`, "document_not_found");
  }

  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      generations: generationId
        ? {
          where: { id: generationId },
          take: 1,
        }
        : {
          where: { jobId: job.id },
          take: 1,
        },
    },
  });

  if (!document) {
    throw createNonRetryableError(`Document ${documentId} not found`, "document_not_found");
  }

  if (document.processingStatus !== "complete") {
    throw createNonRetryableError("Document extraction must be complete before generation", "document_not_ready");
  }

  const generation = document.generations?.[0];
  if (!generation) {
    throw createNonRetryableError(`Generation row not found for job ${job.id}`, "generation_not_found");
  }

  await ensureUserLimitExists(job.userId);
  await assertCanStartGeneration(prisma, job.userId);
  await updateJobProgress(prisma, job.id, workerId, 10);

  const sourcePreparation = await withJobStage(prisma, job, "source_preparation", async () => {
    const orderedExcerpts = sortGenerationExcerpts(
      await prisma.documentExcerpt.findMany({
        where: { documentId },
        orderBy: [
          { slideOrPage: "asc" },
          { charOffset: "asc" },
          { createdAt: "asc" },
        ],
      }),
    ).filter(isUsableGenerationExcerpt);

    const sourceMaterial = generationType === DOCUMENT_GENERATION_TYPES.summary
      ? prepareGpt55SummarySourceMaterial(orderedExcerpts)
      : prepareGenerationSourceMaterial(orderedExcerpts, generationType);

    return { orderedExcerpts, sourceMaterial };
  }, {
    metadata: { generationType },
  });
  const { orderedExcerpts, sourceMaterial } = sourcePreparation;

  if (orderedExcerpts.length === 0) {
    throw createNonRetryableError("No usable excerpts available for generation", "no_usable_excerpts");
  }

  const user = await prisma.user.findUnique({
    where: { id: job.userId },
    select: { plan: true },
  });
  const plan = user?.plan || "free";

  if ((job.retryCount || 0) === 0) {
    await checkAndIncrementDailyTokenCap(job.userId, sourceMaterial.estimatedInputTokens);
  }

  await updateJobProgress(prisma, job.id, workerId, 30);

  const normalizedOptions = normalizeGenerationOptions(generationType, generation.options ?? job.payload?.options ?? {});
  const featureKey = getFeatureKeyForGenerationType(generationType);
  const usageEventType = getUsageEventTypeForGenerationType(generationType);
  const usageLedgerContext = {
    prisma,
    abortSignal: signal,
    userId: job.userId,
    documentId,
    generationId: generation.id,
    jobId: job.id,
    featureKey,
    eventType: usageEventType,
    attemptNumber: (job.retryCount || 0) + 1,
    jobRetryCount: job.retryCount || 0,
    metadata: {
      generationType,
      jobType: job.jobType,
      workerId,
    },
  };
  const generationResult = await generateStudyMaterialFromExcerpts({
    generationType,
    excerpts: orderedExcerpts,
    language: document.language,
    options: normalizedOptions,
    plan,
    usageLedgerContext,
  });

  await updateJobProgress(prisma, job.id, workerId, 85);

  const promptTokens = getPromptTokenUsage(generationResult.usage);
  const completionTokens = getCompletionTokenUsage(generationResult.usage);

  await recordUsageEvent(
    job.userId,
    usageEventType,
    featureKey,
    generationResult.modelUsed,
    promptTokens || sourceMaterial.estimatedInputTokens,
    completionTokens,
    {
      documentId,
      generationId: generation.id,
      jobId: job.id,
      generationType,
      selectedExcerptCount: generationResult.selectedExcerptCount,
      totalExcerptCount: generationResult.totalExcerptCount,
      sampled: generationResult.sampled,
      options: normalizedOptions,
      effectiveOptions: generationResult.effectiveOptions,
    },
  );

  await updateJobProgress(prisma, job.id, workerId, 95);

  const outputCount = generationType === DOCUMENT_GENERATION_TYPES.summary
    ? generationResult.output.text.length
    : generationType === DOCUMENT_GENERATION_TYPES.flashcards
      ? generationResult.output.cards.length
      : generationResult.output.questions.length;

  return {
    generationId: generation.id,
    generationType,
    documentId,
    output: generationResult.output,
    options: normalizedOptions,
    effectiveOptions: generationResult.effectiveOptions,
    grounding: generationResult.grounding ?? null,
    modelUsed: generationResult.modelUsed,
    usage: generationResult.usage,
    estimatedInputTokens: generationResult.estimatedInputTokens ?? sourceMaterial.estimatedInputTokens,
    selectedExcerptCount: generationResult.selectedExcerptCount,
    totalExcerptCount: generationResult.totalExcerptCount,
    sampled: generationResult.sampled,
    outputCount,
  };
}
