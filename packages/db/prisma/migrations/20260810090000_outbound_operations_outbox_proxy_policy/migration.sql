-- Durable workspace egress policy. Backfill from existing enabled proxy rows.
CREATE TYPE "SocialEgressPolicy" AS ENUM ('DIRECT_ALLOWED', 'PROXY_REQUIRED');
CREATE TYPE "OutboundOperationType" AS ENUM ('PUBLISH_POST', 'CREATE_COMMENT', 'REPLY_COMMENT');
CREATE TYPE "OutboundOperationState" AS ENUM (
  'PREPARED',
  'DISPATCHING',
  'REMOTE_CONFIRMED',
  'REMOTE_UNKNOWN',
  'LOCAL_COMMITTED',
  'CONFIRMED_ABSENT',
  'MANUAL_REVIEW',
  'FAILED'
);

ALTER TABLE "Workspace"
  ADD COLUMN "socialEgressPolicy" "SocialEgressPolicy" NOT NULL DEFAULT 'DIRECT_ALLOWED';

UPDATE "Workspace" w
SET "socialEgressPolicy" = 'PROXY_REQUIRED'
WHERE EXISTS (
  SELECT 1
  FROM "WorkspaceProxySetting" p
  WHERE p."workspaceId" = w."id"
    AND p."enabled" = true
);

CREATE TABLE "OutboundOperation" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "operationType" "OutboundOperationType" NOT NULL,
  "resourceType" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "operationGeneration" INTEGER NOT NULL,
  "requestKey" TEXT NOT NULL,
  "state" "OutboundOperationState" NOT NULL DEFAULT 'PREPARED',
  "attemptId" TEXT,
  "fence" INTEGER NOT NULL DEFAULT 0,
  "dispatchAttempts" INTEGER NOT NULL DEFAULT 0,
  "payloadHash" TEXT,
  "routeConfigVersion" INTEGER,
  "routeProxyFingerprint" TEXT,
  "routeCountryCode" TEXT,
  "providerRequestId" TEXT,
  "remoteId" TEXT,
  "remoteCheckpoint" JSONB,
  "reconciliationAttempts" INTEGER NOT NULL DEFAULT 0,
  "requiresManualReview" BOOLEAN NOT NULL DEFAULT false,
  "lastErrorCode" TEXT,
  "lastErrorMessage" TEXT,
  "remoteStartedAt" TIMESTAMP(3),
  "remoteConfirmedAt" TIMESTAMP(3),
  "lastReconciledAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OutboundOperation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OutboxEvent" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT,
  "topic" TEXT NOT NULL,
  "aggregateType" TEXT NOT NULL,
  "aggregateId" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMP(3),
  "claimedBy" TEXT,
  "dispatchedAt" TIMESTAMP(3),
  "dispatchAttempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OutboundOperation_requestKey_key" ON "OutboundOperation"("requestKey");
CREATE UNIQUE INDEX "OutboundOperation_operationType_resourceType_resourceId_ope_key"
  ON "OutboundOperation"(
    "operationType",
    "resourceType",
    "resourceId",
    "operationGeneration"
  );
CREATE INDEX "OutboundOperation_workspaceId_state_createdAt_idx"
  ON "OutboundOperation"("workspaceId", "state", "createdAt");
CREATE INDEX "OutboundOperation_resourceType_resourceId_createdAt_idx"
  ON "OutboundOperation"("resourceType", "resourceId", "createdAt");

CREATE INDEX "OutboxEvent_workspaceId_idx" ON "OutboxEvent"("workspaceId");
CREATE INDEX "OutboxEvent_topic_createdAt_idx" ON "OutboxEvent"("topic", "createdAt");
CREATE INDEX "OutboxEvent_aggregateType_aggregateId_idx"
  ON "OutboxEvent"("aggregateType", "aggregateId");
CREATE INDEX "OutboxEvent_pending_idx"
  ON "OutboxEvent"("createdAt")
  WHERE "dispatchedAt" IS NULL;

CREATE INDEX "Workspace_socialEgressPolicy_idx" ON "Workspace"("socialEgressPolicy");

ALTER TABLE "OutboundOperation"
  ADD CONSTRAINT "OutboundOperation_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OutboxEvent"
  ADD CONSTRAINT "OutboxEvent_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Conservative compatibility rows for legacy unknown/stale publish states.
-- These rows must not republish; they give operators durable manual-review visibility.
INSERT INTO "OutboundOperation" (
  "id",
  "workspaceId",
  "operationType",
  "resourceType",
  "resourceId",
  "operationGeneration",
  "requestKey",
  "state",
  "attemptId",
  "fence",
  "requiresManualReview",
  "lastErrorCode",
  "lastErrorMessage",
  "remoteStartedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  ('legacy_' || p."id"),
  p."workspaceId",
  'PUBLISH_POST',
  'PlatformPost',
  p."id",
  1,
  ('PUBLISH_POST:PlatformPost:' || p."id" || ':1'),
  'REMOTE_UNKNOWN',
  p."publishAttemptId",
  GREATEST(p."publishFence", 1),
  true,
  COALESCE(p."errorCode", 'REMOTE_RESULT_UNKNOWN'),
  COALESCE(p."errorMessage", 'Legacy post had unknown remote outcome at rollout.'),
  p."publishAttemptStartedAt",
  p."createdAt",
  CURRENT_TIMESTAMP
FROM "PlatformPost" p
WHERE p."status" = 'REMOTE_RESULT_UNKNOWN'
ON CONFLICT ("requestKey") DO NOTHING;
