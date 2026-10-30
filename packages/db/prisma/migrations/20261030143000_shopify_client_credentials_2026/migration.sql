-- Upgrade StoreShopifySetting to Shopify 2026 Dev Dashboard OAuth Client Credentials Grant
DELETE FROM "StoreShopifySetting";

ALTER TABLE "StoreShopifySetting"
  DROP COLUMN "adminAccessToken",
  DROP COLUMN "adminTokenMasked",
  ADD COLUMN "clientId" TEXT NOT NULL,
  ADD COLUMN "clientSecret" TEXT NOT NULL,
  ADD COLUMN "clientSecretMasked" TEXT NOT NULL,
  ADD COLUMN "cachedAccessToken" TEXT,
  ADD COLUMN "tokenExpiresAt" TIMESTAMP(3),
  ADD COLUMN "grantedScopes" TEXT;
