-- DropForeignKey
ALTER TABLE "ProtectedCode" DROP CONSTRAINT "ProtectedCode_protectedOfferId_fkey";

-- AlterTable
ALTER TABLE "ProtectedOffer" ADD COLUMN     "code" TEXT NOT NULL,
ADD COLUMN     "codeUpper" TEXT NOT NULL,
ADD COLUMN     "discountNodeId" TEXT;

-- DropTable
DROP TABLE "ProtectedCode";

-- CreateIndex
CREATE INDEX "ProtectedOffer_codeUpper_idx" ON "ProtectedOffer"("codeUpper");

-- CreateIndex
CREATE UNIQUE INDEX "ProtectedOffer_shopId_codeUpper_key" ON "ProtectedOffer"("shopId", "codeUpper");

