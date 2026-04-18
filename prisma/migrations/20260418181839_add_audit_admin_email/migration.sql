-- AlterTable
ALTER TABLE "AdminAuditLog" ADD COLUMN     "adminEmail" TEXT;

-- CreateIndex
CREATE INDEX "AdminAuditLog_adminEmail_createdAt_idx" ON "AdminAuditLog"("adminEmail", "createdAt");
