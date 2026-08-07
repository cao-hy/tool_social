import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AdapterRegistry } from '@socialhub/platform-adapters';
import type { Keyring } from '@socialhub/security';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { RedisService } from '../../infrastructure/redis/redis.service';
import type { AuditService } from '../audit/audit.service';
import type { AdapterRegistryFactory } from '../../infrastructure/adapter-registry.factory';
import { AppError } from '../../common/errors/app-error';
import { CommentsService } from './comments.service';

const queueAdd = vi.hoisted(() => vi.fn());
const queueClose = vi.hoisted(() => vi.fn());

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: queueAdd, close: queueClose })),
}));

describe('CommentsService', () => {
  const commentFindFirst = vi.fn();
  const memberFindFirst = vi.fn();
  const commentReplyCreate = vi.fn();
  const commentAssignmentUpsert = vi.fn();
  const prisma = {
    comment: { findFirst: commentFindFirst },
    workspaceMember: { findFirst: memberFindFirst },
    commentReply: { create: commentReplyCreate },
    commentAssignment: { upsert: commentAssignmentUpsert },
  } as unknown as PrismaService;
  const redis = { getClient: vi.fn(() => ({})) } as unknown as RedisService;
  const audit = { record: vi.fn() } as unknown as AuditService;
  const adapters = {
    requireCapability: vi.fn(() => {
      throw AppError.capabilityUnsupported('PINTEREST', 'replyToComment');
    }),
  } as unknown as AdapterRegistry;
  const adapterFactory = {
    forWorkspace: vi.fn().mockResolvedValue({ adapters }),
  } as unknown as AdapterRegistryFactory;
  const keyring = {} as Keyring;

  beforeEach(() => {
    vi.clearAllMocks();
    commentFindFirst.mockResolvedValue({
      id: 'comment_1',
      workspaceId: 'workspace_1',
      platform: 'PINTEREST',
      status: 'OPEN',
      socialAccount: { token: null, status: 'CONNECTED' },
      platformPost: { contentPostId: 'post_1', contentPost: { title: 'Post' } },
      assignment: null,
      tags: [],
      notes: [],
      replies: [],
    });
  });

  it('reply nền tảng chưa hỗ trợ bị chặn trước khi tạo CommentReply', async () => {
    const service = new CommentsService(prisma, redis, audit, adapterFactory, keyring);

    await expect(
      service.reply(
        'workspace_1',
        'comment_1',
        'user_1',
        { message: 'Xin chào' },
        { requestId: 'req_1' },
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(commentReplyCreate).not.toHaveBeenCalled();
  });

  it('reply Instagram bị chặn sớm nếu token thiếu quyền quản lý comment', async () => {
    const adapter = { replyToComment: vi.fn() };
    vi.mocked(adapters.requireCapability).mockReturnValueOnce(adapter as never);
    commentFindFirst.mockResolvedValueOnce({
      id: 'comment_ig',
      workspaceId: 'workspace_1',
      platform: 'INSTAGRAM',
      externalCommentId: 'ig_comment_1',
      status: 'OPEN',
      socialAccount: {
        token: { accessToken: 'encrypted-token' },
        status: 'CONNECTED',
        scopes: ['instagram_basic', 'pages_read_engagement'],
      },
      platformPost: { contentPostId: 'post_1', contentPost: { title: 'Post' } },
      assignment: null,
      tags: [],
      notes: [],
      replies: [],
    });
    const service = new CommentsService(prisma, redis, audit, adapterFactory, keyring);

    await expect(
      service.reply(
        'workspace_1',
        'comment_ig',
        'user_1',
        { message: 'Cảm ơn bạn' },
        { requestId: 'req_1' },
      ),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('instagram_manage_comments'),
    });
    expect(commentReplyCreate).not.toHaveBeenCalled();
    expect(adapter.replyToComment).not.toHaveBeenCalled();
  });

  it('không gán comment cho member ngoài workspace', async () => {
    memberFindFirst.mockResolvedValueOnce(null);
    const service = new CommentsService(prisma, redis, audit, adapterFactory, keyring);

    await expect(
      service.assign(
        'workspace_1',
        'comment_1',
        'user_1',
        { memberId: 'member_other_workspace' },
        { requestId: 'req_1' },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(commentAssignmentUpsert).not.toHaveBeenCalled();
  });
});
