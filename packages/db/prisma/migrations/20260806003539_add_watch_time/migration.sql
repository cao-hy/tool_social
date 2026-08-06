-- AlterEnum
ALTER TYPE "MediaStatus" ADD VALUE 'ARCHIVED';

-- AlterTable
ALTER TABLE "MetricSnapshot" ADD COLUMN     "avgWatchTime" INTEGER,
ADD COLUMN     "clicks" INTEGER,
ADD COLUMN     "completionRate" DOUBLE PRECISION,
ADD COLUMN     "linkClicks" INTEGER,
ADD COLUMN     "watchTime" INTEGER;

-- AlterTable
ALTER TABLE "PostMetric" ADD COLUMN     "avgWatchTime" INTEGER,
ADD COLUMN     "avgWatchTimeSource" "MetricSource" NOT NULL DEFAULT 'NOT_SYNCED',
ADD COLUMN     "clicks" INTEGER,
ADD COLUMN     "clicksSource" "MetricSource" NOT NULL DEFAULT 'NOT_SYNCED',
ADD COLUMN     "completionRate" DOUBLE PRECISION,
ADD COLUMN     "completionRateSource" "MetricSource" NOT NULL DEFAULT 'NOT_SYNCED',
ADD COLUMN     "linkClicks" INTEGER,
ADD COLUMN     "linkClicksSource" "MetricSource" NOT NULL DEFAULT 'NOT_SYNCED',
ADD COLUMN     "watchTime" INTEGER,
ADD COLUMN     "watchTimeSource" "MetricSource" NOT NULL DEFAULT 'NOT_SYNCED';

-- RenameIndex
ALTER INDEX "PlatformPost_workspaceId_socialAccountId_platform_externalPostI" RENAME TO "PlatformPost_workspaceId_socialAccountId_platform_externalP_key";
