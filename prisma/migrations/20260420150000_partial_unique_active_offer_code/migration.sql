-- Replace the plain unique on (shopId, codeUpper) with a PARTIAL unique that
-- only fires for non-archived offers. Without this, deleting an offer leaves
-- its codeUpper occupying the unique slot — so the merchant can't recreate
-- a protected offer for the same code after deleting the previous one.

DROP INDEX "ProtectedOffer_shopId_codeUpper_key";

CREATE UNIQUE INDEX "ProtectedOffer_shopId_codeUpper_active_key"
  ON "ProtectedOffer" ("shopId", "codeUpper")
  WHERE "archivedAt" IS NULL;
