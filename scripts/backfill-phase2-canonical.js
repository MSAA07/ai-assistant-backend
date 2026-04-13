import "dotenv/config";
import { PrismaClient } from "@prisma/client";

import {
  backfillLegacyDocumentExam,
  backfillLegacyDocumentFlashcards,
  backfillLegacyFlashcardProgress,
  LEGACY_MIGRATION_SOURCE_TYPE,
  linkLegacyExamAttempts,
  runPhase2BackfillReconciliation,
} from "../utils/phase2Backfill.js";

const prisma = new PrismaClient();
const VALIDATE_ONLY = process.argv.includes("--validate-only");

async function findMigratedFlashcardSet(tx, documentId) {
  return tx.flashcardSet.findFirst({
    where: {
      documentId,
      sourceType: LEGACY_MIGRATION_SOURCE_TYPE,
      generationId: null,
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
}

async function findMigratedExamRecord(tx, documentId) {
  return tx.examRecord.findFirst({
    where: {
      documentId,
      sourceType: LEGACY_MIGRATION_SOURCE_TYPE,
      generationId: null,
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
}

async function runBackfill() {
  const documents = await prisma.document.findMany({
    select: {
      id: true,
      flashcards: true,
      examQuestions: true,
    },
    orderBy: { uploadDate: "asc" },
  });

  const stats = {
    documents: documents.length,
    flashcardSetsTouched: 0,
    examRecordsTouched: 0,
    progressRowsMapped: 0,
    progressRowsSkipped: 0,
    attemptsLinked: 0,
  };

  for (const document of documents) {
    await prisma.$transaction(async (tx) => {
      const migratedFlashcardSet = await backfillLegacyDocumentFlashcards(tx, document);
      const migratedExamRecord = await backfillLegacyDocumentExam(tx, document);

      const resolvedFlashcardSet = migratedFlashcardSet ?? await findMigratedFlashcardSet(tx, document.id);
      const resolvedExamRecord = migratedExamRecord ?? await findMigratedExamRecord(tx, document.id);

      const progressStats = await backfillLegacyFlashcardProgress(tx, {
        documentId: document.id,
        migratedSetId: resolvedFlashcardSet?.id ?? null,
      });

      const linkedAttempts = await linkLegacyExamAttempts(tx, {
        documentId: document.id,
        migratedExamRecordId: resolvedExamRecord?.id ?? null,
      });

      if (resolvedFlashcardSet?.id) {
        stats.flashcardSetsTouched += 1;
      }

      if (resolvedExamRecord?.id) {
        stats.examRecordsTouched += 1;
      }

      stats.progressRowsMapped += progressStats.mapped;
      stats.progressRowsSkipped += progressStats.skipped;
      stats.attemptsLinked += linkedAttempts;
    });
  }

  return stats;
}

async function run() {
  try {
    if (!VALIDATE_ONLY) {
      console.log("[phase2-backfill] starting legacy -> canonical backfill");
      const stats = await runBackfill();
      console.log("[phase2-backfill] backfill stats:", JSON.stringify(stats));
    } else {
      console.log("[phase2-backfill] validate-only mode");
    }

    const reconciliation = await runPhase2BackfillReconciliation(prisma);

    if (!reconciliation.ok) {
      console.error(`[phase2-backfill] reconciliation failed (${reconciliation.mismatchCount} mismatches)`);
      for (const mismatch of reconciliation.mismatches.slice(0, 50)) {
        console.error(`- ${mismatch}`);
      }
      if (reconciliation.mismatchCount > 50) {
        console.error(`... ${reconciliation.mismatchCount - 50} more mismatches omitted`);
      }
      process.exitCode = 1;
      return;
    }

    console.log("[phase2-backfill] reconciliation passed");
  } finally {
    await prisma.$disconnect();
  }
}

run().catch(async (error) => {
  console.error("[phase2-backfill] fatal error:", error);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
