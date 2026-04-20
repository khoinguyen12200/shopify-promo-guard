/*
  Warnings:

  - You are about to drop the column `cardNameLast4Ciphertext` on the `RedemptionRecord` table. All the data in the column will be lost.
  - You are about to drop the column `cardNameLast4Hash` on the `RedemptionRecord` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "RedemptionRecord_shopId_protectedOfferId_cardNameLast4Hash_idx";

-- AlterTable
ALTER TABLE "RedemptionRecord" DROP COLUMN "cardNameLast4Ciphertext",
DROP COLUMN "cardNameLast4Hash";
