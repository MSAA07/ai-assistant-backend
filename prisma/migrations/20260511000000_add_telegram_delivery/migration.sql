-- Add Telegram account linking and study delivery metadata.

CREATE TABLE "TelegramConnection" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "telegramUserId" TEXT NOT NULL,
  "telegramChatId" TEXT NOT NULL,
  "telegramUsername" TEXT,
  "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "disconnectedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TelegramConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TelegramLinkToken" (
  "id" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TelegramLinkToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TelegramDeliveryLog" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "itemCount" INTEGER NOT NULL DEFAULT 0,
  "errorMessage" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TelegramDeliveryLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TelegramConnection_userId_key" ON "TelegramConnection"("userId");
CREATE INDEX "TelegramConnection_telegramUserId_idx" ON "TelegramConnection"("telegramUserId");
CREATE INDEX "TelegramConnection_telegramChatId_idx" ON "TelegramConnection"("telegramChatId");
CREATE INDEX "TelegramConnection_disconnectedAt_idx" ON "TelegramConnection"("disconnectedAt");

CREATE UNIQUE INDEX "TelegramLinkToken_token_key" ON "TelegramLinkToken"("token");
CREATE INDEX "TelegramLinkToken_userId_createdAt_idx" ON "TelegramLinkToken"("userId", "createdAt");
CREATE INDEX "TelegramLinkToken_expiresAt_idx" ON "TelegramLinkToken"("expiresAt");

CREATE INDEX "TelegramDeliveryLog_userId_createdAt_idx" ON "TelegramDeliveryLog"("userId", "createdAt");
CREATE INDEX "TelegramDeliveryLog_userId_type_status_idx" ON "TelegramDeliveryLog"("userId", "type", "status");
CREATE INDEX "TelegramDeliveryLog_documentId_createdAt_idx" ON "TelegramDeliveryLog"("documentId", "createdAt");
CREATE INDEX "TelegramDeliveryLog_status_createdAt_idx" ON "TelegramDeliveryLog"("status", "createdAt");

ALTER TABLE "TelegramConnection"
  ADD CONSTRAINT "TelegramConnection_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TelegramLinkToken"
  ADD CONSTRAINT "TelegramLinkToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TelegramDeliveryLog"
  ADD CONSTRAINT "TelegramDeliveryLog_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TelegramDeliveryLog"
  ADD CONSTRAINT "TelegramDeliveryLog_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
