CREATE TYPE "CommentCommandStatus" AS ENUM (
  'QUEUED',
  'SENT',
  'FAILED',
  'REMOTE_UNKNOWN',
  'MANUAL_REVIEW'
);

CREATE TABLE "CommentCreateCommand" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "platformPostId" TEXT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "clientRequestId" TEXT,
  "message" TEXT NOT NULL,
  "status" "CommentCommandStatus" NOT NULL DEFAULT 'QUEUED',
  "externalCommentId" TEXT,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommentCreateCommand_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommentCreateCommand_workspaceId_clientRequestId_key"
  ON "CommentCreateCommand"("workspaceId", "clientRequestId");
CREATE INDEX "CommentCreateCommand_workspaceId_status_idx"
  ON "CommentCreateCommand"("workspaceId", "status");
CREATE INDEX "CommentCreateCommand_platformPostId_idx"
  ON "CommentCreateCommand"("platformPostId");

ALTER TABLE "CommentCreateCommand"
  ADD CONSTRAINT "CommentCreateCommand_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommentCreateCommand"
  ADD CONSTRAINT "CommentCreateCommand_platformPostId_fkey"
  FOREIGN KEY ("platformPostId") REFERENCES "PlatformPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommentCreateCommand"
  ADD CONSTRAINT "CommentCreateCommand_requestedByUserId_fkey"
  FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
