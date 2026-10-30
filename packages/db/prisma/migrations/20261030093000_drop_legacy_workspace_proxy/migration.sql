-- DropForeignKey
ALTER TABLE "WorkspaceProxySetting" DROP CONSTRAINT IF EXISTS "WorkspaceProxySetting_workspaceId_fkey";

-- DropIndex
DROP INDEX IF EXISTS "Workspace_socialEgressPolicy_idx";

-- AlterTable
ALTER TABLE "Workspace" DROP COLUMN IF EXISTS "socialEgressPolicy";

-- DropTable
DROP TABLE IF EXISTS "WorkspaceProxySetting";
