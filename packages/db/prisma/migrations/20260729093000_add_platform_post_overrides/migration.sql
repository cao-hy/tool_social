-- Add per-platform overrides for composer targets.
ALTER TABLE "PlatformPost"
  ADD COLUMN "linkUrl" TEXT,
  ADD COLUMN "options" JSONB;

CREATE TABLE "PlatformPostMedia" (
  "id" TEXT NOT NULL,
  "platformPostId" TEXT NOT NULL,
  "mediaAssetId" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "PlatformPostMedia_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformPostMedia_platformPostId_mediaAssetId_key"
  ON "PlatformPostMedia"("platformPostId", "mediaAssetId");

CREATE INDEX "PlatformPostMedia_platformPostId_position_idx"
  ON "PlatformPostMedia"("platformPostId", "position");

ALTER TABLE "PlatformPostMedia"
  ADD CONSTRAINT "PlatformPostMedia_platformPostId_fkey"
  FOREIGN KEY ("platformPostId") REFERENCES "PlatformPost"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlatformPostMedia"
  ADD CONSTRAINT "PlatformPostMedia_mediaAssetId_fkey"
  FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
