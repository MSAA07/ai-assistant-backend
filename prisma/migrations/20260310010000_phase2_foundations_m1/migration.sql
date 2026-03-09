-- Phase 2 Milestone 1: additive backend foundations

-- Additive columns for ExamAttempt (legacy fields preserved)
ALTER TABLE "ExamAttempt"
ADD COLUMN "examRecordId" TEXT,
ADD COLUMN "status" TEXT NOT NULL DEFAULT 'submitted',
ADD COLUMN "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "lastSavedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "submittedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "feedbackMode" TEXT NOT NULL DEFAULT 'end',
ADD COLUMN "restartFromAttemptId" TEXT;

-- Phase 2 flashcard storage
CREATE TABLE "FlashcardSet" (
  "id" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "generationId" TEXT,
  "title" TEXT,
  "options" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "cardCount" INTEGER NOT NULL DEFAULT 0,
  "sourceType" TEXT NOT NULL DEFAULT 'generation',
  "isLatest" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FlashcardSet_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FlashcardCard" (
  "id" TEXT NOT NULL,
  "setId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "question" TEXT NOT NULL,
  "answer" TEXT NOT NULL,
  "explanation" TEXT,
  "sourceRefs" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "isDeleted" BOOLEAN NOT NULL DEFAULT false,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FlashcardCard_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FlashcardCardState" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "cardId" TEXT NOT NULL,
  "isHidden" BOOLEAN NOT NULL DEFAULT false,
  "isDeletedForUser" BOOLEAN NOT NULL DEFAULT false,
  "mastered" BOOLEAN NOT NULL DEFAULT false,
  "correctCount" INTEGER NOT NULL DEFAULT 0,
  "incorrectCount" INTEGER NOT NULL DEFAULT 0,
  "lastResult" TEXT NOT NULL DEFAULT 'unseen',
  "lastReviewedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FlashcardCardState_pkey" PRIMARY KEY ("id")
);

-- Phase 2 exam storage
CREATE TABLE "ExamRecord" (
  "id" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "generationId" TEXT,
  "title" TEXT,
  "options" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "questionCount" INTEGER NOT NULL DEFAULT 0,
  "sourceType" TEXT NOT NULL DEFAULT 'generation',
  "isLatest" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExamRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExamQuestion" (
  "id" TEXT NOT NULL,
  "examRecordId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "questionType" TEXT NOT NULL,
  "question" TEXT NOT NULL,
  "options" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "correctAnswer" TEXT NOT NULL,
  "explanation" TEXT NOT NULL,
  "sourceRefs" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExamQuestion_pkey" PRIMARY KEY ("id")
);

-- Phase 2 export storage
CREATE TABLE "ExportArtifact" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "examRecordId" TEXT,
  "attemptId" TEXT,
  "format" TEXT NOT NULL DEFAULT 'pdf',
  "config" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "jobId" TEXT,
  "storageKey" TEXT,
  "fileName" TEXT,
  "mimeType" TEXT,
  "fileSize" INTEGER,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readyAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "lastDownloadedAt" TIMESTAMP(3),
  CONSTRAINT "ExportArtifact_pkey" PRIMARY KEY ("id")
);

-- Uniques and indexes
CREATE UNIQUE INDEX "FlashcardCard_setId_position_key" ON "FlashcardCard"("setId", "position");
CREATE UNIQUE INDEX "FlashcardCardState_userId_cardId_key" ON "FlashcardCardState"("userId", "cardId");
CREATE UNIQUE INDEX "ExamQuestion_examRecordId_position_key" ON "ExamQuestion"("examRecordId", "position");

CREATE INDEX "FlashcardSet_documentId_createdAt_idx" ON "FlashcardSet"("documentId", "createdAt");
CREATE INDEX "FlashcardSet_documentId_isLatest_idx" ON "FlashcardSet"("documentId", "isLatest");
CREATE INDEX "FlashcardCard_setId_isDeleted_position_idx" ON "FlashcardCard"("setId", "isDeleted", "position");
CREATE INDEX "FlashcardCardState_userId_lastResult_updatedAt_idx" ON "FlashcardCardState"("userId", "lastResult", "updatedAt");
CREATE INDEX "ExamRecord_documentId_createdAt_idx" ON "ExamRecord"("documentId", "createdAt");
CREATE INDEX "ExamRecord_documentId_isLatest_idx" ON "ExamRecord"("documentId", "isLatest");
CREATE INDEX "ExportArtifact_userId_createdAt_idx" ON "ExportArtifact"("userId", "createdAt");
CREATE INDEX "ExportArtifact_documentId_createdAt_idx" ON "ExportArtifact"("documentId", "createdAt");
CREATE INDEX "ExportArtifact_status_createdAt_idx" ON "ExportArtifact"("status", "createdAt");

CREATE INDEX "ExamAttempt_examRecordId_idx" ON "ExamAttempt"("examRecordId");
CREATE INDEX "ExamAttempt_userId_examRecordId_status_idx" ON "ExamAttempt"("userId", "examRecordId", "status");
CREATE INDEX "ExamAttempt_userId_documentId_startedAt_idx" ON "ExamAttempt"("userId", "documentId", "startedAt");

-- Foreign keys
ALTER TABLE "FlashcardSet"
ADD CONSTRAINT "FlashcardSet_documentId_fkey"
FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FlashcardCard"
ADD CONSTRAINT "FlashcardCard_setId_fkey"
FOREIGN KEY ("setId") REFERENCES "FlashcardSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FlashcardCardState"
ADD CONSTRAINT "FlashcardCardState_cardId_fkey"
FOREIGN KEY ("cardId") REFERENCES "FlashcardCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExamRecord"
ADD CONSTRAINT "ExamRecord_documentId_fkey"
FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExamQuestion"
ADD CONSTRAINT "ExamQuestion_examRecordId_fkey"
FOREIGN KEY ("examRecordId") REFERENCES "ExamRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExportArtifact"
ADD CONSTRAINT "ExportArtifact_documentId_fkey"
FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ExamAttempt"
ADD CONSTRAINT "ExamAttempt_examRecordId_fkey"
FOREIGN KEY ("examRecordId") REFERENCES "ExamRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ExportArtifact"
ADD CONSTRAINT "ExportArtifact_examRecordId_fkey"
FOREIGN KEY ("examRecordId") REFERENCES "ExamRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
