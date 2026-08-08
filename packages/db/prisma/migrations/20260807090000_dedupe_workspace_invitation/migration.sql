-- Deduplicate WorkspaceInvitation entries for (workspaceId, lower(trim(email)))
WITH ranked_invitations AS (
  SELECT
    id,
    "workspaceId",
    lower(trim(email)) AS norm_email,
    ROW_NUMBER() OVER (
      PARTITION BY "workspaceId", lower(trim(email))
      ORDER BY
        CASE WHEN status = 'PENDING' AND ("expiresAt" IS NULL OR "expiresAt" > NOW()) THEN 0 ELSE 1 END,
        "createdAt" DESC
    ) AS rank_num
  FROM "WorkspaceInvitation"
  WHERE status = 'PENDING'
)
UPDATE "WorkspaceInvitation"
SET status = 'EXPIRED', "pendingEmail" = NULL
WHERE id IN (
  SELECT id FROM ranked_invitations WHERE rank_num > 1
);

-- Backfill pendingEmail for winning PENDING invitations
UPDATE "WorkspaceInvitation"
SET
  email = lower(trim(email)),
  "pendingEmail" = lower(trim(email))
WHERE status = 'PENDING' AND "pendingEmail" IS NULL;

-- AlterTable PlatformPost for publish attempt guard and reconciliation
ALTER TABLE "PlatformPost"
  ADD COLUMN IF NOT EXISTS "publishAttemptId" TEXT,
  ADD COLUMN IF NOT EXISTS "publishAttemptStartedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "publishFence" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "reconciliationAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "requiresManualReview" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "lastReconciledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reconciliationError" TEXT;
