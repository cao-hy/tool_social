-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT,
    "avatarUrl" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "SocialAccount" ADD COLUMN "storeId" TEXT;

-- AlterTable
ALTER TABLE "ContentPost" ADD COLUMN "storeId" TEXT;

-- CreateIndex
CREATE INDEX "Store_workspaceId_idx" ON "Store"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Store_workspaceId_slug_key" ON "Store"("workspaceId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Store_workspaceId_name_key" ON "Store"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "SocialAccount_workspaceId_storeId_idx" ON "SocialAccount"("workspaceId", "storeId");

-- CreateIndex
CREATE INDEX "ContentPost_workspaceId_storeId_idx" ON "ContentPost"("workspaceId", "storeId");

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentPost" ADD CONSTRAINT "ContentPost_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;
