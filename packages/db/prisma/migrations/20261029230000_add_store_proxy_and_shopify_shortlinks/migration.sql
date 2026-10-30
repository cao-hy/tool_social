-- CreateTable
CREATE TABLE "StoreProxySetting" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "proxyUrl" TEXT,
    "proxyUrlMasked" TEXT,
    "countryLock" TEXT,
    "targets" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "configVersion" INTEGER NOT NULL DEFAULT 0,
    "lastCheckedAt" TIMESTAMP(3),
    "lastCheckStatus" TEXT,
    "lastIp" TEXT,
    "lastCountryCode" TEXT,
    "lastCheckError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreProxySetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreShopifySetting" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "shopDomain" TEXT NOT NULL,
    "publicDomain" TEXT NOT NULL,
    "shortPathPrefix" TEXT NOT NULL DEFAULT '/s/',
    "adminAccessToken" TEXT NOT NULL,
    "adminTokenMasked" TEXT NOT NULL,
    "encryptionKeyVersion" TEXT NOT NULL,
    "shopName" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "lastCheckStatus" TEXT,
    "lastCheckError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreShopifySetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreShortLink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "shopifyTarget" TEXT NOT NULL,
    "shortPath" TEXT NOT NULL,
    "shortUrl" TEXT NOT NULL,
    "shopifyRedirectId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreShortLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoreProxySetting_storeId_key" ON "StoreProxySetting"("storeId");
CREATE INDEX "StoreProxySetting_workspaceId_idx" ON "StoreProxySetting"("workspaceId");
CREATE INDEX "StoreProxySetting_enabled_idx" ON "StoreProxySetting"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "StoreShopifySetting_storeId_key" ON "StoreShopifySetting"("storeId");
CREATE INDEX "StoreShopifySetting_workspaceId_idx" ON "StoreShopifySetting"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreShortLink_storeId_shortPath_key" ON "StoreShortLink"("storeId", "shortPath");
CREATE UNIQUE INDEX "StoreShortLink_storeId_targetUrl_key" ON "StoreShortLink"("storeId", "targetUrl");
CREATE INDEX "StoreShortLink_workspaceId_storeId_idx" ON "StoreShortLink"("workspaceId", "storeId");

-- AddForeignKey
ALTER TABLE "StoreProxySetting" ADD CONSTRAINT "StoreProxySetting_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoreShopifySetting" ADD CONSTRAINT "StoreShopifySetting_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoreShortLink" ADD CONSTRAINT "StoreShortLink_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
