import { randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { extname } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import type { MediaType } from '@socialhub/shared';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { AppError } from '../../common/errors/app-error';
import { ENV, type ApiEnv } from '../../infrastructure/env.provider';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { CreateMediaUploadInput, ListMediaInput } from './media.schemas';

const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const SIGNED_UPLOAD_EXPIRES_SECONDS = 10 * 60;
const SIGNED_READ_EXPIRES_SECONDS = 10 * 60;

@Injectable()
export class MediaService {
  private readonly s3: S3Client;
  private readonly publicS3: S3Client;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {
    this.s3 = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    });
    this.publicS3 = new S3Client({
      endpoint: env.S3_PUBLIC_BASE_URL ?? env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    });
  }

  async usage(workspaceId: string) {
    const [mediaAggregate, counts, disk] = await Promise.all([
      this.prisma.mediaAsset.aggregate({
        where: { workspaceId, deletedAt: null },
        _sum: { sizeBytes: true },
      }),
      this.prisma.mediaAsset.groupBy({
        by: ['type'],
        where: { workspaceId, deletedAt: null },
        _count: { _all: true },
        _sum: { sizeBytes: true },
      }),
      this.diskUsage(),
    ]);

    return {
      disk,
      media: {
        totalBytes: mediaAggregate._sum.sizeBytes ?? 0,
        byType: counts.map((item) => ({
          type: item.type,
          count: item._count._all,
          bytes: item._sum.sizeBytes ?? 0,
        })),
      },
    };
  }

  async list(workspaceId: string, query: ListMediaInput) {
    const items = await this.prisma.mediaAsset.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        type: query.type,
        status: query.status,
        originalFileName: query.q ? { contains: query.q, mode: 'insensitive' } : undefined,
      },
      include: {
        uploadedBy: { select: { name: true, email: true } },
        _count: { select: { posts: true, platformPosts: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
      take: query.limit + 1,
    });

    const pageItems = items.slice(0, query.limit);
    return {
      items: await Promise.all(pageItems.map((media) => this.toLibraryItem(media))),
      nextCursor: items.length > query.limit ? (pageItems.at(-1)?.id ?? null) : null,
    };
  }

  async createUpload(workspaceId: string, uploadedById: string, input: CreateMediaUploadInput) {
    if (
      input.declaredMimeType === 'image/svg+xml' ||
      input.fileName.toLowerCase().endsWith('.svg')
    ) {
      throw AppError.validation('SVG không được hỗ trợ vì rủi ro bảo mật.');
    }

    const storageKey = this.storageKey(workspaceId, input.fileName);
    const media = await this.prisma.mediaAsset.create({
      data: {
        workspaceId,
        storageKey,
        originalFileName: input.fileName,
        sizeBytes: input.sizeBytes,
        uploadedById,
        status: 'PENDING_UPLOAD',
        type: this.typeFromDeclaredMime(input.declaredMimeType),
      },
    });

    const command = new PutObjectCommand({
      Bucket: this.env.S3_BUCKET,
      Key: storageKey,
      ContentType: input.declaredMimeType,
      ContentLength: input.sizeBytes,
    });

    return {
      mediaAsset: await this.toMediaView(media),
      uploadUrl: await getSignedUrl(this.publicS3, command, {
        expiresIn: SIGNED_UPLOAD_EXPIRES_SECONDS,
      }),
      expiresInSeconds: SIGNED_UPLOAD_EXPIRES_SECONDS,
    };
  }

  async confirmUpload(workspaceId: string, mediaAssetId: string) {
    const media = await this.prisma.mediaAsset.findFirst({
      where: { id: mediaAssetId, workspaceId, deletedAt: null },
    });
    if (!media) throw AppError.notFound('media asset');

    const object = await this.s3.send(
      new GetObjectCommand({ Bucket: this.env.S3_BUCKET, Key: media.storageKey }),
    );
    const bytes = Buffer.from((await object.Body?.transformToByteArray()) ?? []);
    if (bytes.length === 0) throw AppError.validation('File upload rỗng hoặc chưa tồn tại.');

    const detected = await fileTypeFromBuffer(bytes);
    const detectedMime = detected?.mime;

    if (!detectedMime) throw AppError.validation('Không xác định được MIME từ magic bytes.');
    if (
      detectedMime === 'image/svg+xml' ||
      media.originalFileName?.toLowerCase().endsWith('.svg')
    ) {
      throw AppError.validation('SVG không được hỗ trợ vì rủi ro bảo mật.');
    }

    const mediaType = this.mediaTypeFromDetectedMime(detectedMime);
    const image = mediaType === 'IMAGE' ? sharp(bytes, { failOn: 'none' }).rotate() : null;
    const metadata = image ? await image.metadata().catch(() => undefined) : undefined;

    let finalBytes: Buffer<ArrayBufferLike> = bytes;
    if (mediaType === 'IMAGE') {
      if (!image) throw AppError.validation('Không xử lý được ảnh upload.');
      try {
        finalBytes = await image
          .toFormat(detected?.ext === 'png' ? 'png' : detected?.ext === 'webp' ? 'webp' : 'jpeg')
          .toBuffer();
      } catch {
        throw AppError.validation('Ảnh upload bị lỗi hoặc không đọc được bằng bộ xử lý ảnh.');
      }

      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.env.S3_BUCKET,
          Key: media.storageKey,
          Body: finalBytes,
          ContentType: detectedMime,
        }),
      );
    }

    const updated = await this.prisma.mediaAsset.update({
      where: { id: media.id },
      data: {
        type: mediaType,
        status: 'READY',
        mimeType: detectedMime,
        sizeBytes: finalBytes.length,
        width: metadata?.width,
        height: metadata?.height,
      },
    });

    return this.toMediaView(updated);
  }

  async uploadObject(
    workspaceId: string,
    mediaAssetId: string,
    input: { bytes: Buffer; declaredMimeType: string },
  ) {
    const media = await this.prisma.mediaAsset.findFirst({
      where: { id: mediaAssetId, workspaceId, deletedAt: null },
    });
    if (!media) throw AppError.notFound('media asset');
    if (media.status !== 'PENDING_UPLOAD') {
      throw AppError.conflict('Media asset này đã được upload hoặc đã bị xử lý.');
    }
    if (input.bytes.length === 0) throw AppError.validation('File upload rỗng.');
    if (input.bytes.length > 100 * 1024 * 1024) {
      throw AppError.validation('File vượt quá giới hạn 100MB.');
    }
    if (media.sizeBytes !== null && media.sizeBytes !== input.bytes.length) {
      throw AppError.validation('Kích thước file upload không khớp với metadata đã đăng ký.');
    }

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.env.S3_BUCKET,
        Key: media.storageKey,
        Body: input.bytes,
        ContentType: input.declaredMimeType,
        ContentLength: input.bytes.length,
      }),
    );

    return { uploaded: true };
  }

  async delete(workspaceId: string, mediaAssetId: string) {
    const media = await this.prisma.mediaAsset.findFirst({
      where: { id: mediaAssetId, workspaceId, deletedAt: null },
      include: { _count: { select: { posts: true, platformPosts: true } } },
    });
    if (!media) throw AppError.notFound('media asset');

    const usageCount = media._count.posts + media._count.platformPosts;
    if (usageCount > 0) {
      throw AppError.conflict('Media đang được bài viết sử dụng. Gỡ khỏi bài viết trước khi xóa.');
    }

    await Promise.all([
      this.s3.send(new DeleteObjectCommand({ Bucket: this.env.S3_BUCKET, Key: media.storageKey })),
      media.thumbnailKey
        ? this.s3.send(
            new DeleteObjectCommand({ Bucket: this.env.S3_BUCKET, Key: media.thumbnailKey }),
          )
        : Promise.resolve(),
    ]);

    await this.prisma.mediaAsset.update({
      where: { id: media.id },
      data: { deletedAt: new Date() },
    });

    return { deleted: true };
  }

  private typeFromDeclaredMime(mimeType: string): MediaType {
    if (mimeType.startsWith('video/')) return 'VIDEO';
    return 'IMAGE';
  }

  private mediaTypeFromDetectedMime(mimeType: string): MediaType {
    if (ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) return 'IMAGE';
    if (ALLOWED_VIDEO_MIME_TYPES.has(mimeType)) return 'VIDEO';
    throw AppError.validation(`MIME không được hỗ trợ: ${mimeType}`);
  }

  private storageKey(workspaceId: string, fileName: string): string {
    const extension = extname(fileName)
      .toLowerCase()
      .replace(/[^a-z0-9.]/g, '');
    return `workspaces/${workspaceId}/media/${randomUUID()}${extension}`;
  }

  private async diskUsage() {
    const stats = await statfs(process.cwd(), { bigint: true });
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bfree * stats.bsize;
    const availableBytes = stats.bavail * stats.bsize;
    const usedBytes = totalBytes - freeBytes;

    return {
      path: process.cwd(),
      totalBytes: Number(totalBytes),
      freeBytes: Number(freeBytes),
      availableBytes: Number(availableBytes),
      usedBytes: Number(usedBytes),
      usedPercent: Number(totalBytes > 0n ? (usedBytes * 10_000n) / totalBytes : 0n) / 100,
    };
  }

  private async toLibraryItem(media: {
    id: string;
    type: MediaType;
    status: string;
    storageKey: string;
    originalFileName: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
    width: number | null;
    height: number | null;
    durationSec: number | null;
    createdAt: Date;
    updatedAt: Date;
    uploadedBy: { name: string | null; email: string } | null;
    _count: { posts: number; platformPosts: number };
  }) {
    return {
      ...(await this.toMediaView(media)),
      updatedAt: media.updatedAt,
      uploadedByName: media.uploadedBy?.name ?? null,
      uploadedByEmail: media.uploadedBy?.email ?? null,
      usage: {
        contentPosts: media._count.posts,
        platformPosts: media._count.platformPosts,
        total: media._count.posts + media._count.platformPosts,
      },
    };
  }

  private async toMediaView(media: {
    id: string;
    type: MediaType;
    status: string;
    storageKey: string;
    originalFileName: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
    width: number | null;
    height: number | null;
    durationSec: number | null;
    createdAt: Date;
  }) {
    const readUrl =
      media.status === 'READY'
        ? await getSignedUrl(
            this.publicS3,
            new GetObjectCommand({ Bucket: this.env.S3_BUCKET, Key: media.storageKey }),
            { expiresIn: SIGNED_READ_EXPIRES_SECONDS },
          )
        : null;

    return {
      id: media.id,
      type: media.type,
      status: media.status,
      originalFileName: media.originalFileName,
      mimeType: media.mimeType,
      sizeBytes: media.sizeBytes,
      width: media.width,
      height: media.height,
      durationSec: media.durationSec,
      createdAt: media.createdAt,
      readUrl,
    };
  }
}
