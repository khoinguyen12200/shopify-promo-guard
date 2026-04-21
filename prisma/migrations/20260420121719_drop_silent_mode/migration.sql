/*
  Warnings:

  - You are about to drop the column `isAppOwned` on the `ProtectedCode` table. All the data in the column will be lost.
  - You are about to drop the column `replacedDiscountNodeId` on the `ProtectedCode` table. All the data in the column will be lost.
  - You are about to drop the column `discountIdAppOwned` on the `ProtectedOffer` table. All the data in the column will be lost.
  - You are about to drop the column `mode` on the `ProtectedOffer` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "ProtectedCode" DROP COLUMN "isAppOwned",
DROP COLUMN "replacedDiscountNodeId";

-- AlterTable
ALTER TABLE "ProtectedOffer" DROP COLUMN "discountIdAppOwned",
DROP COLUMN "mode";
