-- Backfill pendingEmail for existing PENDING invitations
UPDATE "WorkspaceInvitation"
SET
  "email" = lower(trim("email")),
  "pendingEmail" = lower(trim("email"))
WHERE "status" = 'PENDING' AND "pendingEmail" IS NULL;
