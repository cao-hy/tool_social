ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXTERNAL_POSTS_SYNC_REQUESTED';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SyncJobStatus') THEN
    CREATE TYPE "SyncJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PostSourceType') THEN
    CREATE TYPE "PostSourceType" AS ENUM ('SOCIALHUB', 'EXTERNAL');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PlatformPostSyncSource') THEN
    CREATE TYPE "PlatformPostSyncSource" AS ENUM ('API', 'WEBHOOK');
  END IF;
END $$;

ALTER TABLE "ContentPost"
  ADD COLUMN IF NOT EXISTS "sourceType" "PostSourceType" NOT NULL DEFAULT 'SOCIALHUB',
  ADD COLUMN IF NOT EXISTS "externalSyncedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "externalPermalink" TEXT,
  ADD COLUMN IF NOT EXISTS "externalAuthor" JSONB;

ALTER TABLE "PlatformPost"
  ADD COLUMN IF NOT EXISTS "externalCreatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "externalUpdatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "externalRaw" JSONB,
  ADD COLUMN IF NOT EXISTS "syncSource" "PlatformPostSyncSource";

DROP INDEX IF EXISTS "PlatformPost_socialAccountId_externalPostId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "PlatformPost_workspaceId_socialAccountId_platform_externalPostId_key"
  ON "PlatformPost"("workspaceId", "socialAccountId", "platform", "externalPostId");

CREATE INDEX IF NOT EXISTS "ContentPost_workspaceId_sourceType_publishedAt_idx"
  ON "ContentPost"("workspaceId", "sourceType", "publishedAt");

CREATE TABLE IF NOT EXISTS "ExternalPostSyncJob" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "socialAccountId" TEXT NOT NULL,
  "platform" "Platform" NOT NULL,
  "status" "SyncJobStatus" NOT NULL,
  "cutoffDate" TIMESTAMP(3) NOT NULL,
  "cursor" TEXT,
  "scannedCount" INTEGER NOT NULL DEFAULT 0,
  "importedCount" INTEGER NOT NULL DEFAULT 0,
  "updatedCount" INTEGER NOT NULL DEFAULT 0,
  "skippedCount" INTEGER NOT NULL DEFAULT 0,
  "failedCount" INTEGER NOT NULL DEFAULT 0,
  "lastError" JSONB,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ExternalPostSyncJob_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ExternalPostSyncJob_workspaceId_fkey'
  ) THEN
    ALTER TABLE "ExternalPostSyncJob"
      ADD CONSTRAINT "ExternalPostSyncJob_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ExternalPostSyncJob_socialAccountId_fkey'
  ) THEN
    ALTER TABLE "ExternalPostSyncJob"
      ADD CONSTRAINT "ExternalPostSyncJob_socialAccountId_fkey"
      FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ExternalPostSyncJob_createdByUserId_fkey'
  ) THEN
    ALTER TABLE "ExternalPostSyncJob"
      ADD CONSTRAINT "ExternalPostSyncJob_createdByUserId_fkey"
      FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "ExternalPostSyncJob_workspaceId_createdAt_idx"
  ON "ExternalPostSyncJob"("workspaceId", "createdAt");

CREATE INDEX IF NOT EXISTS "ExternalPostSyncJob_socialAccountId_status_idx"
  ON "ExternalPostSyncJob"("socialAccountId", "status");

CREATE INDEX IF NOT EXISTS "ExternalPostSyncJob_workspaceId_socialAccountId_status_idx"
  ON "ExternalPostSyncJob"("workspaceId", "socialAccountId", "status");
