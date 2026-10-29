import { describe, expect, it, vi } from 'vitest';
import { listPostsQuerySchema } from '../posts.schemas';
import { PostsService } from '../posts.service';

function createServiceWithCandidatePlatformPosts(candidatePlatformPosts: unknown[]) {
  const prisma = {
    platformPost: {
      findMany: vi.fn().mockResolvedValue(candidatePlatformPosts),
    },
    contentPost: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
  };

  const service = Object.create(PostsService.prototype) as PostsService;
  Reflect.set(service, 'prisma', prisma);
  return { service, prisma };
}

describe('PostsService.list mediaType filter', () => {
  const sampleCandidates = [
    {
      id: 'pp_ext_tt_video',
      contentPostId: 'post_ext_video',
      platform: 'TIKTOK',
      externalPostId: 'tt_1',
      externalUrl: 'https://www.tiktok.com/@brand/video/1',
      externalRaw: { cover_image_url: 'https://cdn.example.com/tt-cover.jpg' },
      media: [],
    },
    {
      id: 'pp_ext_ig_image',
      contentPostId: 'post_ext_image',
      platform: 'INSTAGRAM',
      externalPostId: 'ig_1',
      externalUrl: 'https://www.instagram.com/p/abc/',
      externalRaw: {
        media_type: 'IMAGE',
        media_url: 'https://cdn.example.com/ig-photo.jpg',
      },
      media: [],
    },
    {
      id: 'pp_ext_fb_text',
      contentPostId: 'post_ext_text_only',
      platform: 'FACEBOOK',
      externalPostId: 'fb_1',
      externalUrl: 'https://www.facebook.com/posts/1',
      externalRaw: { message: 'Status text without attachment' },
      media: [],
    },
    {
      id: 'pp_override_video',
      contentPostId: 'post_platform_override_video',
      platform: 'YOUTUBE',
      externalPostId: null,
      externalUrl: null,
      externalRaw: null,
      media: [{ mediaAsset: { type: 'VIDEO' } }],
    },
  ];

  it('validates mediaType query enum in listPostsQuerySchema', () => {
    expect(listPostsQuerySchema.parse({ mediaType: 'VIDEO' }).mediaType).toBe('VIDEO');
    expect(listPostsQuerySchema.parse({ mediaType: 'IMAGE' }).mediaType).toBe('IMAGE');
    expect(listPostsQuerySchema.parse({ mediaType: 'NONE' }).mediaType).toBe('NONE');
    expect(() => listPostsQuerySchema.parse({ mediaType: 'AUDIO' })).toThrow();
  });

  it('builds VIDEO filter matching both local MediaAsset and external/platform VIDEO posts on items and statusCounts', async () => {
    const { service, prisma } = createServiceWithCandidatePlatformPosts(sampleCandidates);
    const query = listPostsQuerySchema.parse({ mediaType: 'VIDEO', status: 'PUBLISHED' });

    await service.list('ws_1', query);

    expect(prisma.platformPost.findMany).toHaveBeenCalledTimes(1);
    const expectedMediaClause = {
      OR: [
        { media: { some: { mediaAsset: { type: 'VIDEO' } } } },
        { id: { in: ['post_ext_video', 'post_platform_override_video'] } },
      ],
    };

    expect(prisma.contentPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: 'ws_1',
          status: 'PUBLISHED',
          AND: [expectedMediaClause],
        }),
      }),
    );
    expect(prisma.contentPost.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: 'ws_1',
          status: undefined,
          AND: [expectedMediaClause],
        }),
      }),
    );
  });

  it('builds IMAGE filter matching local IMAGE and external IMAGE posts', async () => {
    const { service, prisma } = createServiceWithCandidatePlatformPosts(sampleCandidates);
    const query = listPostsQuerySchema.parse({ mediaType: 'IMAGE' });

    await service.list('ws_1', query);

    const expectedMediaClause = {
      OR: [
        { media: { some: { mediaAsset: { type: 'IMAGE' } } } },
        { id: { in: ['post_ext_image'] } },
      ],
    };
    expect(prisma.contentPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [expectedMediaClause],
        }),
      }),
    );
  });

  it('builds NONE filter excluding posts with platform/external media while keeping text-only external posts', async () => {
    const { service, prisma } = createServiceWithCandidatePlatformPosts(sampleCandidates);
    const query = listPostsQuerySchema.parse({ mediaType: 'NONE' });

    await service.list('ws_1', query);

    const expectedMediaClause = {
      media: { none: {} },
      id: {
        notIn: ['post_ext_video', 'post_ext_image', 'post_platform_override_video'],
      },
    };
    expect(prisma.contentPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [expectedMediaClause],
        }),
      }),
    );
  });
});
