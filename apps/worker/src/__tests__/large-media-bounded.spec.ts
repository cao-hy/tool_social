import { GetObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { mediaInputFromAsset } from '../processors/publish-post';

describe('Large media bounded reads (W1)', () => {
  it.each(['TIKTOK', 'YOUTUBE', 'PINTEREST', 'FACEBOOK'] as const)(
    'prepares %s videos with an S3 range reader instead of eager full-object bytes',
    async (platform) => {
      const send = vi.fn(async (command: GetObjectCommand) => {
        expect(command).toBeInstanceOf(GetObjectCommand);
        return {
          Body: {
            transformToByteArray: vi.fn().mockResolvedValue(new Uint8Array([10, 11, 12])),
          },
        };
      });

      const media = await mediaInputFromAsset(
        {
          client: { send } as never,
          bucket: 'media-bucket',
          publicBaseUrl: 'https://media.example',
        },
        {
          type: 'VIDEO',
          storageKey: 'workspaces/ws/video.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 512 * 1024 * 1024,
          width: 1080,
          height: 1920,
          durationSec: 60,
        },
        platform,
      );

      expect(media.bytes).toBeUndefined();
      expect(media.readRange).toEqual(expect.any(Function));
      expect(send).not.toHaveBeenCalled();

      await expect(media.readRange?.(10, 19)).resolves.toEqual(new Uint8Array([10, 11, 12]));
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0].input).toMatchObject({
        Bucket: 'media-bucket',
        Key: 'workspaces/ws/video.mp4',
        Range: 'bytes=10-19',
      });
    },
  );
});
