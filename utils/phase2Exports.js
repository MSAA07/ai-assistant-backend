function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeExportArtifactInput(input = {}) {
  return {
    userId: normalizeString(input.userId),
    documentId: normalizeString(input.documentId),
    examRecordId: normalizeString(input.examRecordId) || null,
    attemptId: normalizeString(input.attemptId) || null,
    format: normalizeString(input.format) || "pdf",
    config: input.config && typeof input.config === "object" && !Array.isArray(input.config)
      ? input.config
      : {},
    status: normalizeString(input.status) || "queued",
    jobId: normalizeString(input.jobId) || null,
    storageKey: normalizeString(input.storageKey) || null,
    fileName: normalizeString(input.fileName) || null,
    mimeType: normalizeString(input.mimeType) || null,
    fileSize: Number.isFinite(Number(input.fileSize)) ? Number(input.fileSize) : null,
    errorMessage: normalizeString(input.errorMessage) || null,
    readyAt: input.readyAt ?? null,
    expiresAt: input.expiresAt ?? null,
    lastDownloadedAt: input.lastDownloadedAt ?? null,
  };
}

export function serializeExportArtifact(artifact) {
  return {
    id: artifact?.id ?? null,
    userId: artifact?.userId ?? null,
    documentId: artifact?.documentId ?? null,
    examRecordId: artifact?.examRecordId ?? null,
    attemptId: artifact?.attemptId ?? null,
    format: artifact?.format ?? "pdf",
    config: artifact?.config ?? {},
    status: artifact?.status ?? "queued",
    jobId: artifact?.jobId ?? null,
    storageKey: artifact?.storageKey ?? null,
    fileName: artifact?.fileName ?? null,
    mimeType: artifact?.mimeType ?? null,
    fileSize: Number.isFinite(Number(artifact?.fileSize)) ? Number(artifact.fileSize) : null,
    errorMessage: artifact?.errorMessage ?? null,
    createdAt: artifact?.createdAt ?? null,
    readyAt: artifact?.readyAt ?? null,
    expiresAt: artifact?.expiresAt ?? null,
    lastDownloadedAt: artifact?.lastDownloadedAt ?? null,
  };
}

