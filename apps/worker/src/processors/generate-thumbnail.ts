import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { PrismaClientInstance } from '@socialhub/db';
import type { QueuePayload } from '@socialhub/shared';
import sharp from 'sharp';
import { z } from 'zod';
import { logger } from '../logger';

const THUMBNAIL_CONTENT_TYPE = 'image/webp';
const payloadSchema = z.object({
  mediaAssetId: z.string().min(1),
  workspaceId: z.string().min(1),
});

export function createGenerateThumbnailProcessor(input: {
  prisma: PrismaClientInstance;
  storage: { client: S3Client; bucket: string };
}) {
  return async (job: { data: unknown; id?: string }) => {
    const payload = payloadSchema.parse(job.data) as QueuePayload<'generate-thumbnail'>;
    const media = await input.prisma.mediaAsset.findFirst({
      where: {
        id: payload.mediaAssetId,
        workspaceId: payload.workspaceId,
        deletedAt: null,
      },
    });

    if (!media) return { skipped: true, reason: 'not_found' };
    if (media.thumbnailKey && media.status === 'READY') {
      return { skipped: true, reason: 'already_ready' };
    }
    if (media.type !== 'VIDEO') return { skipped: true, reason: 'not_video' };

    const thumbnailKey = buildThumbnailKey(media.workspaceId, media.id);
    const workdir = join(tmpdir(), `socialhub-thumb-${media.id}-${randomUUID()}`);
    const inputPath = join(workdir, 'source-video');
    const framePath = join(workdir, 'frame.jpg');

    try {
      await input.prisma.mediaAsset.update({
        where: { id: media.id },
        data: { status: 'PROCESSING' },
      });

      await mkdir(workdir, { recursive: true });
      const object = await input.storage.client.send(
        new GetObjectCommand({ Bucket: input.storage.bucket, Key: media.storageKey }),
      );
      await writeS3BodyToFile(object.Body, inputPath);

      const thumbnailBytes = await createVideoThumbnail(inputPath, framePath);
      await input.storage.client.send(
        new PutObjectCommand({
          Bucket: input.storage.bucket,
          Key: thumbnailKey,
          Body: thumbnailBytes,
          ContentType: THUMBNAIL_CONTENT_TYPE,
          ContentLength: thumbnailBytes.length,
        }),
      );

      await input.prisma.mediaAsset.update({
        where: { id: media.id },
        data: { status: 'READY', thumbnailKey },
      });

      return { thumbnailKey };
    } catch (error) {
      await input.prisma.mediaAsset
        .update({ where: { id: media.id }, data: { status: 'FAILED' } })
        .catch(() => undefined);
      logger.error(
        {
          queue: 'generate-thumbnail',
          jobId: job.id,
          mediaAssetId: media.id,
          err: error,
        },
        'Tạo thumbnail video thất bại',
      );
      throw error;
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

async function writeS3BodyToFile(body: unknown, outputPath: string): Promise<void> {
  if (!body) throw new Error('Video source is empty or missing');

  if (body instanceof Readable) {
    await pipeline(body, createWriteStream(outputPath));
    return;
  }

  if (hasByteArrayTransform(body)) {
    await writeFile(outputPath, Buffer.from(await body.transformToByteArray()));
    return;
  }

  throw new Error('Unsupported S3 body stream');
}

function hasByteArrayTransform(
  body: unknown,
): body is { transformToByteArray(): Promise<Uint8Array> } {
  return (
    typeof body === 'object' &&
    body !== null &&
    'transformToByteArray' in body &&
    typeof body.transformToByteArray === 'function'
  );
}

async function createVideoThumbnail(inputPath: string, framePath: string): Promise<Buffer> {
  try {
    await runFfmpeg([
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      '1',
      '-i',
      inputPath,
      '-frames:v',
      '1',
      framePath,
    ]);

    return sharp(await readFile(framePath), { failOn: 'none' })
      .rotate()
      .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();
  } catch (error) {
    logger.warn({ err: error }, 'Không trích được frame video, dùng thumbnail dự phòng');
    return createFallbackVideoThumbnail();
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

async function createFallbackVideoThumbnail(): Promise<Buffer> {
  const overlay = Buffer.from(`
    <svg width="640" height="360" xmlns="http://www.w3.org/2000/svg">
      <circle cx="320" cy="164" r="52" fill="rgba(255,255,255,0.16)" />
      <path d="M304 134 L304 194 L354 164 Z" fill="white" />
      <text x="320" y="250" text-anchor="middle" font-family="Arial, sans-serif" font-size="32" font-weight="700" fill="white">VIDEO</text>
    </svg>
  `);

  return sharp({
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
}

function buildThumbnailKey(workspaceId: string, mediaAssetId: string): string {
  return `workspaces/${workspaceId}/media-thumbnails/${mediaAssetId}.webp`;
}
