CREATE TABLE "WorkspaceProxySetting" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "proxyUrl" TEXT,
    "proxyUrlMasked" TEXT,
    "countryLock" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "lastCheckStatus" TEXT,
    "lastIp" TEXT,
    "lastCountryCode" TEXT,
    "lastCheckError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceProxySetting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkspaceProxySetting_workspaceId_key" ON "WorkspaceProxySetting"("workspaceId");
CREATE INDEX "WorkspaceProxySetting_workspaceId_idx" ON "WorkspaceProxySetting"("workspaceId");
CREATE INDEX "WorkspaceProxySetting_enabled_idx" ON "WorkspaceProxySetting"("enabled");

ALTER TABLE "WorkspaceProxySetting" ADD CONSTRAINT "WorkspaceProxySetting_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
