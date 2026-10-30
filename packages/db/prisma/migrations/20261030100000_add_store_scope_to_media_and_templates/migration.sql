-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN "storeId" TEXT;

-- AlterTable
ALTER TABLE "ReplyTemplate" ADD COLUMN "storeId" TEXT;

-- DropIndex
DROP INDEX "ReplyTemplate_workspaceId_name_key";

-- CreateIndex
CREATE INDEX "MediaAsset_workspaceId_storeId_idx" ON "MediaAsset"("workspaceId", "storeId");

-- CreateIndex
CREATE INDEX "ReplyTemplate_workspaceId_storeId_idx" ON "ReplyTemplate"("workspaceId", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "ReplyTemplate_workspaceId_storeId_name_key" ON "ReplyTemplate"("workspaceId", "storeId", "name");

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplyTemplate" ADD CONSTRAINT "ReplyTemplate_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;
