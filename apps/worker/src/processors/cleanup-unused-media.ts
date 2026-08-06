import { DeleteObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { PrismaClient } from '@socialhub/db';
import type { Processor } from 'bullmq';
import { logger } from '../logger';

export interface CleanupUnusedMediaDependencies {
  prisma: PrismaClient;
  storage: { client: S3Client; bucket: string };
}

export function createCleanupUnusedMediaProcessor({
  prisma,
  storage,
}: CleanupUnusedMediaDependencies): Processor<unknown, unknown, string> {
  return async (job) => {
    const payload = job.data as { olderThanDays: number };
    const olderThanDays = payload.olderThanDays;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    logger.info({ olderThanDays, cutoffDate }, 'Bắt đầu quét dọn media');

    // 1. Chuyển các media PENDING_UPLOAD quá hạn thành DELETE_PENDING
    const abandonedMedia = await prisma.mediaAsset.findMany({
      where: {
        status: 'PENDING_UPLOAD',
        createdAt: { lt: cutoffDate },
      },
      select: { id: true },
    });

    if (abandonedMedia.length > 0) {
      await prisma.mediaAsset.updateMany({
        where: { id: { in: abandonedMedia.map((m) => m.id) } },
        data: { status: 'DELETE_PENDING' },
      });
      logger.info(
        { count: abandonedMedia.length },
        'Đã chuyển media bị bỏ quên sang DELETE_PENDING',
      );
    }

    // 2. Lấy danh sách cần xóa (chỉ lấy tối đa 100 cái mỗi run để tránh quá tải/timeout)
    const pendingDelete = await prisma.mediaAsset.findMany({
      where: {
        status: { in: ['DELETE_PENDING', 'DELETE_FAILED'] },
      },
      select: { id: true, storageKey: true, thumbnailKey: true, workspaceId: true },
      take: 100,
    });

    if (pendingDelete.length === 0) {
      logger.info('Không có media nào cần xóa');
      return;
    }

    logger.info({ count: pendingDelete.length }, 'Đang tiến hành xóa media từ S3');

    let deletedCount = 0;
    let failedCount = 0;

    for (const media of pendingDelete) {
      try {
        const keys = [
          ...new Set([media.storageKey, media.thumbnailKey].filter(Boolean)),
        ] as string[];

        await Promise.all(
          keys.map((key) =>
            storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key })),
          ),
        );

        await prisma.mediaAsset.delete({
          where: { id: media.id },
        });

        deletedCount++;
      } catch (error) {
        failedCount++;
        const message = error instanceof Error ? error.message : 'Unknown S3 error';
        logger.warn(
          { mediaId: media.id, err: message },
          'Xóa media thất bại, chuyển sang DELETE_FAILED',
        );

        await prisma.mediaAsset.update({
          where: { id: media.id },
          data: { status: 'DELETE_FAILED' },
        });
      }
    }

    logger.info({ deletedCount, failedCount }, 'Hoàn tất vòng dọn dẹp media');

    // Nếu có lỗi, throw để BullMQ ghi nhận job fail (nhưng DB đã update DELETE_FAILED)
    if (failedCount > 0) {
      throw new Error(`Có ${failedCount} media xóa không thành công`);
    }
  };
}
