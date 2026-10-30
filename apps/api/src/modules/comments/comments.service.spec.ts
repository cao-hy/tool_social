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
    withWorkspace: vi.fn(
      async (_workspaceId: string, fn: (ctx: { adapters: AdapterRegistry }) => Promise<unknown>) =>
        fn({ adapters }),
    ),
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

  it('T19 two distinct top-level comment intents create two commands, operations, and job identities', async () => {
    const platformPost = {
      id: 'platform_post_1',
      workspaceId: 'workspace_1',
      platform: 'YOUTUBE',
      status: 'PUBLISHED',
      externalPostId: 'remote_post_1',
      socialAccountId: 'account_1',
      socialAccount: {
        id: 'account_1',
        status: 'CONNECTED',
        token: { accessToken: 'encrypted' },
        scopes: ['https://www.googleapis.com/auth/youtube.force-ssl'],
      },
      contentPost: {},
    };
    const createdCommands: Array<{ id: string }> = [];
    const outboxEvents = new Map<string, unknown>();
    const operationUpsert = vi.fn(async ({ create }) => ({
      id: `operation_${create.resourceId}`,
      ...create,
    }));
    const outboxCreate = vi.fn(async ({ data }) => {
      const id = `outbox_${data.aggregateId}`;
      const event = { id, ...data };
      outboxEvents.set(id, event);
      return event;
    });
    const tx = {
      commentCreateCommand: {
        create: vi.fn(async ({ data }) => {
          const command = { id: `command_${createdCommands.length + 1}`, ...data };
          createdCommands.push(command);
          return command;
        }),
      },
      outboundOperation: { upsert: operationUpsert },
      backgroundJob: {
        upsert: vi.fn(async ({ create }) => ({ id: `bg_${create.jobId}`, ...create })),
      },
      outboxEvent: { create: outboxCreate },
    };
    const prismaForCreate = {
      platformPost: { findFirst: vi.fn(async () => platformPost) },
      outboxEvent: {
        findUnique: vi.fn(async ({ where }) => outboxEvents.get(where.id)),
        update: vi.fn(async () => ({})),
      },
      $transaction: vi.fn(async (fn) => fn(tx)),
    };
    const adapter = { createComment: vi.fn() };
    const service = new CommentsService(
      prismaForCreate as never,
      redis,
      audit,
      {
        withWorkspace: vi.fn(async (_workspaceId, fn) =>
          fn({ adapters: { requireCapability: vi.fn(() => adapter) } as never }),
        ),
      } as never,
      keyring,
    );

    await service.createPlatformComment(
      'workspace_1',
      'platform_post_1',
      'user_1',
      { message: 'same text' },
      { requestId: 'req_1' },
    );
    await service.createPlatformComment(
      'workspace_1',
      'platform_post_1',
      'user_1',
      { message: 'same text' },
      { requestId: 'req_2' },
    );

    expect(tx.commentCreateCommand.create).toHaveBeenCalledTimes(2);
    expect(operationUpsert).toHaveBeenCalledTimes(2);
    expect(operationUpsert.mock.calls.map((call) => call[0].create.resourceId)).toEqual([
      'command_1',
      'command_2',
    ]);
    expect(outboxCreate).toHaveBeenCalledTimes(2);
    const payloads = outboxCreate.mock.calls.map((call) => call[0].data.payload);
    expect(payloads.map((payload) => payload.jobId)).toEqual([
      'create-platform-comment-outbound-operation_command_1',
      'create-platform-comment-outbound-operation_command_2',
    ]);
  });

  it('bulkCreatePlatformComments chặn khi target platformPosts trộn lẫn nhiều Store', async () => {
    const prismaForBulk = {
      platformPost: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'pp_1',
            socialAccount: { storeId: 'store_a' },
            contentPost: { storeId: 'store_a' },
          },
          {
            id: 'pp_2',
            socialAccount: { storeId: 'store_b' },
            contentPost: { storeId: 'store_b' },
          },
        ]),
      },
    };
    const service = new CommentsService(
      prismaForBulk as never,
      redis,
      audit,
      adapterFactory,
      keyring,
    );

    await expect(
      service.bulkCreatePlatformComments(
        'workspace_1',
        'user_1',
        { platformPostIds: ['pp_1', 'pp_2'], message: 'Ghim link sản phẩm' },
        { requestId: 'req_bulk_1' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('listTemplates lọc theo storeId + trả về mẫu riêng của Store đứng trước mẫu dùng chung', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'tpl_shared',
        workspaceId: 'workspace_1',
        storeId: null,
        name: 'A Mẫu chung',
        body: '1',
      },
      {
        id: 'tpl_store',
        workspaceId: 'workspace_1',
        storeId: 'store_a',
        name: 'Z Mẫu riêng',
        body: '2',
      },
    ]);
    const service = new CommentsService(
      { replyTemplate: { findMany } } as never,
      redis,
      audit,
      adapterFactory,
      keyring,
    );

    const res = await service.listTemplates('workspace_1', 'store_a');
    expect(findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'workspace_1', OR: [{ storeId: 'store_a' }, { storeId: null }] },
      orderBy: { name: 'asc' },
    });
    expect(res.items.map((item) => item.id)).toEqual(['tpl_store', 'tpl_shared']);
  });

  it('bulkModerateComments chặn khi danh sách bình luận thuộc nhiều Store khác nhau', async () => {
    const prismaForBulk = {
      comment: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'c_1',
            parentId: null,
            isFromPage: true,
            isHidden: false,
            platform: 'FACEBOOK',
            socialAccountId: 'acc_a',
            socialAccount: { storeId: 'store_a' },
          },
          {
            id: 'c_2',
            parentId: null,
            isFromPage: true,
            isHidden: false,
            platform: 'FACEBOOK',
            socialAccountId: 'acc_b',
            socialAccount: { storeId: 'store_b' },
          },
        ]),
      },
    };
    const service = new CommentsService(
      prismaForBulk as never,
      redis,
      audit,
      adapterFactory,
      keyring,
    );

    await expect(
      service.bulkModerateComments(
        'workspace_1',
        'user_1',
        { commentIds: ['c_1', 'c_2'], action: 'DELETE_FROM_PLATFORM' },
        { requestId: 'req_bulk_mod_1' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('bulkModerateComments khử trùng bình luận con khi bình luận cha đã xóa và giãn nhịp delay theo từng kênh', async () => {
    const outboxEvents = new Map<
      string,
      { id: string; payload: { options: { delay?: number } } }
    >();
    const fullComments: Record<string, unknown> = {
      parent_1: {
        id: 'parent_1',
        workspaceId: 'workspace_1',
        platformPostId: 'pp_1',
        socialAccountId: 'acc_1',
        platform: 'FACEBOOK',
        externalCommentId: 'ext_parent_1',
        parentId: null,
        isFromPage: true,
        isHidden: false,
        status: 'OPEN',
        socialAccount: {
          id: 'acc_1',
          storeId: 'store_a',
          status: 'CONNECTED',
          token: { accessToken: 'enc' },
          scopes: ['pages_manage_engagement'],
        },
        platformPost: { id: 'pp_1', contentPostId: 'post_1', contentPost: { title: 'Post 1' } },
        assignment: null,
        tags: [],
        notes: [],
        replies: [],
      },
      parent_2: {
        id: 'parent_2',
        workspaceId: 'workspace_1',
        platformPostId: 'pp_2',
        socialAccountId: 'acc_1',
        platform: 'FACEBOOK',
        externalCommentId: 'ext_parent_2',
        parentId: null,
        isFromPage: true,
        isHidden: false,
        status: 'OPEN',
        socialAccount: {
          id: 'acc_1',
          storeId: 'store_a',
          status: 'CONNECTED',
          token: { accessToken: 'enc' },
          scopes: ['pages_manage_engagement'],
        },
        platformPost: { id: 'pp_2', contentPostId: 'post_2', contentPost: { title: 'Post 2' } },
        assignment: null,
        tags: [],
        notes: [],
        replies: [],
      },
    };

    const tx = {
      comment: { updateMany: vi.fn(async () => ({ count: 1 })) },
      outboundOperation: {
        findFirst: vi.fn(async () => null),
        upsert: vi.fn(async ({ create }) => ({ id: `op_${create.resourceId}`, ...create })),
      },
      backgroundJob: {
        upsert: vi.fn(async ({ create }) => ({ id: `bg_${create.jobId}`, ...create })),
      },
      outboxEvent: {
        create: vi.fn(async ({ data }) => {
          const id = `outbox_${data.aggregateId}`;
          const ev = { id, ...data };
          outboxEvents.set(id, ev);
          return ev;
        }),
      },
    };

    const prismaForBulk = {
      comment: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'child_of_1',
            parentId: 'parent_1',
            isFromPage: false,
            isHidden: false,
            platform: 'FACEBOOK',
            socialAccountId: 'acc_1',
            socialAccount: { storeId: 'store_a' },
          },
          {
            id: 'parent_1',
            parentId: null,
            isFromPage: true,
            isHidden: false,
            platform: 'FACEBOOK',
            socialAccountId: 'acc_1',
            socialAccount: { storeId: 'store_a' },
          },
          {
            id: 'parent_2',
            parentId: null,
            isFromPage: true,
            isHidden: false,
            platform: 'FACEBOOK',
            socialAccountId: 'acc_1',
            socialAccount: { storeId: 'store_a' },
          },
        ]),
        findFirst: vi.fn(async ({ where }) => fullComments[where.id]),
      },
      outboxEvent: {
        findUnique: vi.fn(async ({ where }) => outboxEvents.get(where.id)),
        update: vi.fn(async () => ({})),
      },
      $transaction: vi.fn(async (fn) => fn(tx)),
    };

    const adapter = { deleteComment: vi.fn() };
    const service = new CommentsService(
      prismaForBulk as never,
      redis,
      audit,
      {
        offlineAdapters: () => ({ requireCapability: vi.fn(() => adapter) }),
      } as never,
      keyring,
    );

    const summary = await service.bulkModerateComments(
      'workspace_1',
      'user_1',
      {
        commentIds: ['child_of_1', 'parent_1', 'parent_2'],
        action: 'DELETE_FROM_PLATFORM',
      },
      { requestId: 'req_dedup_stagger' },
    );

    expect(summary.requested).toBe(3);
    expect(summary.processed).toBe(3);
    expect(summary.queued).toBe(2);
    expect(summary.skippedByParent).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.results.find((r) => r.id === 'child_of_1')?.skippedByParent).toBe(true);

    // Kiểm tra job thứ 1 trên acc_1 không delay, job thứ 2 trên cùng acc_1 có delay = 900ms
    const delays = Array.from(outboxEvents.values()).map((e) => e.payload.options.delay);
    expect(delays).toEqual([undefined, 900]);
  });

  it('bulkModerateComments chặn ẩn (HIDE_ON_PLATFORM) đối với bình luận do chính Facebook Page đăng', async () => {
    const pageComment = {
      id: 'page_cmt_1',
      workspaceId: 'workspace_1',
      platformPostId: 'pp_1',
      socialAccountId: 'acc_1',
      platform: 'FACEBOOK',
      externalCommentId: 'ext_1',
      parentId: null,
      isFromPage: true,
      isHidden: false,
      status: 'OPEN',
      socialAccount: {
        id: 'acc_1',
        storeId: 'store_a',
        status: 'CONNECTED',
        token: { accessToken: 'enc' },
        scopes: ['pages_manage_engagement'],
      },
      platformPost: { id: 'pp_1', contentPostId: 'post_1', contentPost: { title: 'Post 1' } },
      assignment: null,
      tags: [],
      notes: [],
      replies: [],
    };
    const prismaForHide = {
      comment: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'page_cmt_1',
            parentId: null,
            isFromPage: true,
            isHidden: false,
            platform: 'FACEBOOK',
            socialAccountId: 'acc_1',
            socialAccount: { storeId: 'store_a' },
          },
        ]),
        findFirst: vi.fn().mockResolvedValue(pageComment),
      },
    };
    const service = new CommentsService(
      prismaForHide as never,
      redis,
      audit,
      adapterFactory,
      keyring,
    );

    const summary = await service.bulkModerateComments(
      'workspace_1',
      'user_1',
      { commentIds: ['page_cmt_1'], action: 'HIDE_ON_PLATFORM' },
      { requestId: 'req_hide_page' },
    );

    expect(summary.failed).toBe(1);
    expect(summary.queued).toBe(0);
    expect(summary.results[0]?.errorCode).toBe('VALIDATION_ERROR');
  });
});
