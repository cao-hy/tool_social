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
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  buildJobId,
  buildQueueJobOptions,
  type MediaType,
  type QueuePayload,
} from '@socialhub/shared';
import { Queue } from 'bullmq';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { AppError } from '../../common/errors/app-error';
import { ENV, type ApiEnv } from '../../infrastructure/env.provider';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';
import type { CreateMediaUploadInput, ListMediaInput } from './media.schemas';

const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const SIGNED_UPLOAD_EXPIRES_SECONDS = 10 * 60;
const SIGNED_READ_EXPIRES_SECONDS = 10 * 60;
const THUMBNAIL_CONTENT_TYPE = 'image/webp';

@Injectable()
export class MediaService implements OnModuleDestroy {
  private readonly s3: S3Client;
  private readonly publicS3: S3Client;
  private readonly thumbnailQueue: Queue;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {
    this.thumbnailQueue = new Queue('generate-thumbnail', { connection: this.redis.getClient() });
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

  async onModuleDestroy(): Promise<void> {
    await this.thumbnailQueue.close();
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

  async get(workspaceId: string, mediaAssetId: string) {
    const media = await this.prisma.mediaAsset.findFirst({
      where: { id: mediaAssetId, workspaceId, deletedAt: null },
    });
    if (!media) throw AppError.notFound('media asset');

    return this.toMediaView(media);
  }

  async getObject(workspaceId: string, mediaAssetId: string, range?: string) {
    const media = await this.prisma.mediaAsset.findFirst({
      where: { id: mediaAssetId, workspaceId, deletedAt: null, status: 'READY' },
    });
    if (!media) throw AppError.notFound('media asset');

    const object = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.env.S3_BUCKET,
        Key: media.storageKey,
        Range: sanitizeRange(range),
      }),
    );

    return {
      body: object.Body,
      statusCode: object.ContentRange ? 206 : 200,
      contentType: object.ContentType ?? media.mimeType ?? 'application/octet-stream',
      contentLength: object.ContentLength,
      contentRange: object.ContentRange,
    };
  }

  async getThumbnail(workspaceId: string, mediaAssetId: string) {
    const media = await this.prisma.mediaAsset.findFirst({
      where: { id: mediaAssetId, workspaceId, deletedAt: null },
    });
    if (!media?.thumbnailKey) throw AppError.notFound('media thumbnail');

    const object = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.env.S3_BUCKET,
        Key: media.thumbnailKey,
      }),
    );

    return {
      body: object.Body,
      statusCode: 200,
      contentType: object.ContentType ?? THUMBNAIL_CONTENT_TYPE,
      contentLength: object.ContentLength,
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

    const probeBytes = await this.readObjectBytes(media.storageKey, 'bytes=0-8191');
    if (probeBytes.length === 0) throw AppError.validation('File upload rỗng hoặc chưa tồn tại.');

    const detected = await fileTypeFromBuffer(probeBytes);
    const detectedMime = detected?.mime;

    if (!detectedMime) throw AppError.validation('Không xác định được MIME từ magic bytes.');
    if (
      detectedMime === 'image/svg+xml' ||
      media.originalFileName?.toLowerCase().endsWith('.svg')
    ) {
      throw AppError.validation('SVG không được hỗ trợ vì rủi ro bảo mật.');
    }

    const mediaType = this.mediaTypeFromDetectedMime(detectedMime);
    if (mediaType === 'VIDEO') {
      const updated = await this.prisma.mediaAsset.update({
        where: { id: media.id },
        data: {
          type: mediaType,
          status: 'PROCESSING',
          mimeType: detectedMime,
          sizeBytes: media.sizeBytes,
        },
      });

      try {
        await this.enqueueThumbnail(updated.workspaceId, updated.id);
      } catch (error) {
        await this.prisma.mediaAsset
          .update({ where: { id: updated.id }, data: { status: 'FAILED' } })
          .catch(() => undefined);
        throw AppError.internal(
          `Đã upload video nhưng chưa thể đưa vào queue xử lý thumbnail: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
      return this.toMediaView(updated);
    }

    const bytes = await this.readObjectBytes(media.storageKey);
    const image = sharp(bytes, { failOn: 'none' }).rotate();
    const metadata = await image.metadata().catch(() => undefined);

    let finalBytes: Buffer<ArrayBufferLike> = bytes;
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

    const thumbnailKey = await this.createImageThumbnail(media.workspaceId, media.id, finalBytes);

    const updated = await this.prisma.mediaAsset.update({
      where: { id: media.id },
      data: {
        type: mediaType,
        status: 'READY',
        mimeType: detectedMime,
        sizeBytes: finalBytes.length,
        width: metadata?.width,
        height: metadata?.height,
        thumbnailKey,
      },
    });

    return this.toMediaView(updated);
  }

  private async readObjectBytes(storageKey: string, range?: string): Promise<Buffer> {
    const object = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.env.S3_BUCKET,
        Key: storageKey,
        Range: range,
      }),
    );
    return Buffer.from((await object.Body?.transformToByteArray()) ?? []);
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

  async archive(workspaceId: string, mediaAssetId: string) {
    const media = await this.prisma.mediaAsset.findFirst({
      where: { id: mediaAssetId, workspaceId, deletedAt: null },
      include: {
        platformPosts: {
          where: { platformPost: { contentPost: { deletedAt: null } } },
          select: { platformPost: { select: { status: true } } },
        },
        posts: {
          where: { contentPost: { deletedAt: null } },
          select: { contentPost: { select: { status: true } } },
        },
      },
    });
    if (!media) throw AppError.notFound('media asset');

    // Kiểm tra tất cả post đang sử dụng phải là PUBLISHED
    const isAllPlatformPublished = media.platformPosts.every(
      (p) => p.platformPost.status === 'PUBLISHED',
    );
    const isAllContentPublished = media.posts.every((p) => p.contentPost.status === 'PUBLISHED');

    if (!isAllPlatformPublished || !isAllContentPublished) {
      throw AppError.conflict('Chưa thể dọn dẹp vì có bài viết đang sử dụng chưa được Publish.');
    }

    if (media.status === 'ARCHIVED') {
      return { archived: true };
    }

    let thumbnailKey = media.thumbnailKey;
    if (!thumbnailKey) {
      thumbnailKey =
        media.type === 'IMAGE'
          ? await this.createImageThumbnail(
              media.workspaceId,
              media.id,
              await this.readObjectBytes(media.storageKey),
            )
          : await this.createVideoThumbnail(media.workspaceId, media.id);
    }

    // Chỉ xóa file gốc, giữ thumbnail để UI còn xem lại lịch sử.
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.env.S3_BUCKET, Key: media.storageKey }),
    );

    await this.prisma.mediaAsset.update({
      where: { id: media.id },
      data: {
        status: 'ARCHIVED',
        thumbnailKey,
        sizeBytes: 0,
      },
    });

    return { archived: true };
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

  private thumbnailKey(workspaceId: string, mediaAssetId: string): string {
    return `workspaces/${workspaceId}/media-thumbnails/${mediaAssetId}.webp`;
  }

  private displayUrl(workspaceId: string, mediaAssetId: string): string {
    return `${this.env.API_BASE_URL.replace(/\/$/, '')}/api/v1/workspaces/${workspaceId}/media/${mediaAssetId}/object`;
  }

  private thumbnailUrl(workspaceId: string, mediaAssetId: string): string {
    return `${this.env.API_BASE_URL.replace(/\/$/, '')}/api/v1/workspaces/${workspaceId}/media/${mediaAssetId}/thumbnail`;
  }

  private async createImageThumbnail(
    workspaceId: string,
    mediaAssetId: string,
    bytes: Buffer,
  ): Promise<string> {
    const key = this.thumbnailKey(workspaceId, mediaAssetId);
    const thumbnailBytes = await sharp(bytes, { failOn: 'none' })
      .rotate()
      .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.env.S3_BUCKET,
        Key: key,
        Body: thumbnailBytes,
        ContentType: THUMBNAIL_CONTENT_TYPE,
        ContentLength: thumbnailBytes.length,
      }),
    );

    return key;
  }

  private async createVideoThumbnail(workspaceId: string, mediaAssetId: string): Promise<string> {
    const key = this.thumbnailKey(workspaceId, mediaAssetId);
    const overlay = Buffer.from(`
      <svg width="640" height="360" xmlns="http://www.w3.org/2000/svg">
        <circle cx="320" cy="164" r="52" fill="rgba(255,255,255,0.16)" />
        <path d="M304 134 L304 194 L354 164 Z" fill="white" />
        <text x="320" y="250" text-anchor="middle" font-family="Arial, sans-serif" font-size="32" font-weight="700" fill="white">VIDEO</text>
      </svg>
    `);
    const thumbnailBytes = await sharp({
      create: {
        width: 640,
        height: 360,
        channels: 4,
        background: { r: 15, g: 23, b: 42, alpha: 1 },
      },
    })
      .composite([{ input: overlay }])
      .webp({ quality: 76 })
      .toBuffer();

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.env.S3_BUCKET,
        Key: key,
        Body: thumbnailBytes,
        ContentType: THUMBNAIL_CONTENT_TYPE,
        ContentLength: thumbnailBytes.length,
      }),
    );

    return key;
  }

  private async enqueueThumbnail(workspaceId: string, mediaAssetId: string): Promise<void> {
    const payload: QueuePayload<'generate-thumbnail'> = { workspaceId, mediaAssetId };
    const jobId = buildJobId('generate-thumbnail', payload);
    await this.thumbnailQueue.add(
      'generate-thumbnail',
      payload,
      buildQueueJobOptions('generate-thumbnail', jobId),
    );
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
    workspaceId: string;
    type: MediaType;
    status: string;
    storageKey: string;
    originalFileName: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
    width: number | null;
    height: number | null;
    durationSec: number | null;
    thumbnailKey: string | null;
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
    workspaceId: string;
    type: MediaType;
    status: string;
    storageKey: string;
    originalFileName: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
    width: number | null;
    height: number | null;
    durationSec: number | null;
    thumbnailKey: string | null;
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
    const thumbnailUrl = media.thumbnailKey ? this.thumbnailUrl(media.workspaceId, media.id) : null;

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
      thumbnailUrl,
      displayUrl:
        media.status === 'READY'
          ? this.displayUrl(media.workspaceId, media.id)
          : media.status === 'ARCHIVED'
            ? thumbnailUrl
            : null,
      readUrl,
    };
  }
}

function sanitizeRange(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^bytes=\d*-\d*$/.test(value) ? value : undefined;
}
