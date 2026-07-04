// Shared route helper functions to reduce duplication across route files

export function normalizePositiveInteger(value, fallback, { min = 1, max = 100 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

export function createHttpError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) {
    error.code = code;
  }
  return error;
}

export async function getOwnedDocument(prisma, documentId, userId) {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, userId: true },
  });

  if (!document) {
    return { status: 404, error: "Document not found" };
  }

  if (document.userId !== userId) {
    return { status: 403, error: "Access denied" };
  }

  return { document };
}

export async function getOwnedExamRecord(prisma, examId, userId) {
  const examRecord = await prisma.examRecord.findUnique({
    where: { id: examId },
    include: {
      document: {
        select: { userId: true },
      },
    },
  });

  if (!examRecord) {
    return { status: 404, error: "Exam not found" };
  }

  if (examRecord.document.userId !== userId) {
    return { status: 403, error: "Access denied" };
  }

  return { examRecord };
}
