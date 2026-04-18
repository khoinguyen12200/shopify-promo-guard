-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "encryptionKey" TEXT NOT NULL,
    "protectedDataLevel" INTEGER NOT NULL DEFAULT 0,
    "timezone" TEXT,
    "currencyCode" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProtectedOffer" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "shardVersion" INTEGER NOT NULL DEFAULT 0,
    "coldStartStatus" TEXT NOT NULL DEFAULT 'pending',
    "coldStartDone" INTEGER NOT NULL DEFAULT 0,
    "coldStartTotal" INTEGER NOT NULL DEFAULT 0,
    "validationFunctionActivated" BOOLEAN NOT NULL DEFAULT false,
    "discountIdAppOwned" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "ProtectedOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProtectedCode" (
    "id" TEXT NOT NULL,
    "protectedOfferId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "codeUpper" TEXT NOT NULL,
    "discountNodeId" TEXT,
    "isAppOwned" BOOLEAN NOT NULL DEFAULT false,
    "replacedDiscountNodeId" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "ProtectedCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RedemptionRecord" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "protectedOfferId" TEXT NOT NULL,
    "orderGid" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "codeUsed" TEXT NOT NULL,
    "customerGid" TEXT,
    "emailCiphertext" TEXT,
    "phoneCiphertext" TEXT,
    "addressCiphertext" TEXT,
    "ipCiphertext" TEXT,
    "phoneHash" TEXT,
    "emailCanonicalHash" TEXT,
    "addressFullHash" TEXT,
    "ipHash24" TEXT,
    "emailMinhashSketch" TEXT,
    "addressMinhashSketch" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RedemptionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShardState" (
    "id" TEXT NOT NULL,
    "protectedOfferId" TEXT NOT NULL,
    "shardKey" TEXT NOT NULL,
    "metafieldGid" TEXT,
    "metafieldNamespace" TEXT NOT NULL,
    "metafieldKey" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL DEFAULT 0,
    "entryCount" INTEGER NOT NULL DEFAULT 0,
    "oldestRecordId" TEXT,
    "newestRecordId" TEXT,
    "lastRebuiltAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ShardState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlaggedOrder" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "protectedOfferId" TEXT NOT NULL,
    "orderGid" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "customerGid" TEXT,
    "riskLevel" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "facts" TEXT NOT NULL,
    "riskAssessmentGid" TEXT,
    "tagged" BOOLEAN NOT NULL DEFAULT false,
    "merchantAction" TEXT NOT NULL DEFAULT 'pending',
    "merchantActionAt" TIMESTAMP(3),
    "merchantActorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FlaggedOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payload" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "webhookGid" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "payloadHash" TEXT NOT NULL,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceRequest" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "customerGid" TEXT,
    "payload" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,

    CONSTRAINT "ComplianceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");

-- CreateIndex
CREATE INDEX "Shop_uninstalledAt_idx" ON "Shop"("uninstalledAt");

-- CreateIndex
CREATE INDEX "ProtectedOffer_shopId_status_idx" ON "ProtectedOffer"("shopId", "status");

-- CreateIndex
CREATE INDEX "ProtectedCode_codeUpper_idx" ON "ProtectedCode"("codeUpper");

-- CreateIndex
CREATE UNIQUE INDEX "ProtectedCode_protectedOfferId_codeUpper_key" ON "ProtectedCode"("protectedOfferId", "codeUpper");

-- CreateIndex
CREATE INDEX "RedemptionRecord_shopId_protectedOfferId_phoneHash_idx" ON "RedemptionRecord"("shopId", "protectedOfferId", "phoneHash");

-- CreateIndex
CREATE INDEX "RedemptionRecord_shopId_protectedOfferId_emailCanonicalHash_idx" ON "RedemptionRecord"("shopId", "protectedOfferId", "emailCanonicalHash");

-- CreateIndex
CREATE INDEX "RedemptionRecord_shopId_protectedOfferId_addressFullHash_idx" ON "RedemptionRecord"("shopId", "protectedOfferId", "addressFullHash");

-- CreateIndex
CREATE INDEX "RedemptionRecord_shopId_protectedOfferId_ipHash24_idx" ON "RedemptionRecord"("shopId", "protectedOfferId", "ipHash24");

-- CreateIndex
CREATE INDEX "RedemptionRecord_shopId_protectedOfferId_createdAt_idx" ON "RedemptionRecord"("shopId", "protectedOfferId", "createdAt");

-- CreateIndex
CREATE INDEX "RedemptionRecord_customerGid_idx" ON "RedemptionRecord"("customerGid");

-- CreateIndex
CREATE UNIQUE INDEX "RedemptionRecord_shopId_orderGid_protectedOfferId_key" ON "RedemptionRecord"("shopId", "orderGid", "protectedOfferId");

-- CreateIndex
CREATE UNIQUE INDEX "ShardState_protectedOfferId_shardKey_key" ON "ShardState"("protectedOfferId", "shardKey");

-- CreateIndex
CREATE INDEX "FlaggedOrder_shopId_merchantAction_idx" ON "FlaggedOrder"("shopId", "merchantAction");

-- CreateIndex
CREATE INDEX "FlaggedOrder_shopId_createdAt_idx" ON "FlaggedOrder"("shopId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FlaggedOrder_shopId_orderGid_key" ON "FlaggedOrder"("shopId", "orderGid");

-- CreateIndex
CREATE INDEX "Job_shopId_status_idx" ON "Job"("shopId", "status");

-- CreateIndex
CREATE INDEX "Job_status_createdAt_idx" ON "Job"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_webhookGid_key" ON "WebhookEvent"("webhookGid");

-- CreateIndex
CREATE INDEX "WebhookEvent_shopId_topic_receivedAt_idx" ON "WebhookEvent"("shopId", "topic", "receivedAt");

-- CreateIndex
CREATE INDEX "AuditLog_shopId_createdAt_idx" ON "AuditLog"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_shopId_action_idx" ON "AuditLog"("shopId", "action");

-- CreateIndex
CREATE INDEX "ComplianceRequest_shopId_topic_status_idx" ON "ComplianceRequest"("shopId", "topic", "status");

-- AddForeignKey
ALTER TABLE "ProtectedOffer" ADD CONSTRAINT "ProtectedOffer_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProtectedCode" ADD CONSTRAINT "ProtectedCode_protectedOfferId_fkey" FOREIGN KEY ("protectedOfferId") REFERENCES "ProtectedOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RedemptionRecord" ADD CONSTRAINT "RedemptionRecord_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RedemptionRecord" ADD CONSTRAINT "RedemptionRecord_protectedOfferId_fkey" FOREIGN KEY ("protectedOfferId") REFERENCES "ProtectedOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShardState" ADD CONSTRAINT "ShardState_protectedOfferId_fkey" FOREIGN KEY ("protectedOfferId") REFERENCES "ProtectedOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlaggedOrder" ADD CONSTRAINT "FlaggedOrder_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlaggedOrder" ADD CONSTRAINT "FlaggedOrder_protectedOfferId_fkey" FOREIGN KEY ("protectedOfferId") REFERENCES "ProtectedOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceRequest" ADD CONSTRAINT "ComplianceRequest_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
