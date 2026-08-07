-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MediaStatus" ADD VALUE 'DELETE_PENDING';
ALTER TYPE "MediaStatus" ADD VALUE 'DELETE_FAILED';

-- DropIndex
DROP INDEX "SocialAccount_workspaceId_platform_externalAccountId_extern_key";

-- DropIndex
DROP INDEX "WorkspaceInvitation_workspaceId_email_status_key";

-- AlterTable
ALTER TABLE "WorkspaceInvitation" ADD COLUMN     "pendingEmail" TEXT;

-- AlterTable
ALTER TABLE "WorkspaceProxySetting" ADD COLUMN     "configVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceInvitation_workspaceId_pendingEmail_key" ON "WorkspaceInvitation"("workspaceId", "pendingEmail");
