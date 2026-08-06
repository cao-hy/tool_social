-- Drop the previous composite unique index that includes externalPageId which could be NULL
DROP INDEX IF EXISTS "SocialAccount_workspaceId_platform_externalAccountId_externalPageId_key";

-- Create a partial unique index for rows where externalPageId IS NULL
CREATE UNIQUE INDEX social_account_without_page_unique
ON "SocialAccount" (
  "workspaceId",
  "platform",
  "externalAccountId"
)
WHERE "externalPageId" IS NULL;

-- Create a partial unique index for rows where externalPageId IS NOT NULL
CREATE UNIQUE INDEX social_account_with_page_unique
ON "SocialAccount" (
  "workspaceId",
  "platform",
  "externalAccountId",
  "externalPageId"
)
WHERE "externalPageId" IS NOT NULL;
