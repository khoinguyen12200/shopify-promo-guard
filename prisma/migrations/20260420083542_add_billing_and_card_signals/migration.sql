-- AlterTable
ALTER TABLE "RedemptionRecord" ADD COLUMN     "billingAddressCiphertext" TEXT,
ADD COLUMN     "billingAddressFullHash" TEXT,
ADD COLUMN     "cardNameLast4Ciphertext" TEXT,
ADD COLUMN     "cardNameLast4Hash" TEXT;

-- CreateIndex
CREATE INDEX "RedemptionRecord_shopId_protectedOfferId_billingAddressFull_idx" ON "RedemptionRecord"("shopId", "protectedOfferId", "billingAddressFullHash");

-- CreateIndex
CREATE INDEX "RedemptionRecord_shopId_protectedOfferId_cardNameLast4Hash_idx" ON "RedemptionRecord"("shopId", "protectedOfferId", "cardNameLast4Hash");
