import { describe, expect, it, vi } from 'vitest';
import { RemoteRequestError } from '@socialhub/shared';
import { Keyring, encryptToken } from '@socialhub/security';
import { createCreatePlatformCommentProcessor } from '../processors/create-platform-comment';
import { createReplyPlatformCommentProcessor } from '../processors/reply-platform-comment';
import { dispatchClaimedOutboxEvent } from '../outbox-dispatcher';

function encryptedAccount(keyring: Keyring) {
  return {
    id: 'account_1',
    workspaceId: 'workspace_1',
    platform: 'YOUTUBE',
    externalAccountId: 'external_account_1',
    externalPageId: null,
    name: 'Channel',
    avatarUrl: null,
    status: 'CONNECTED',
    disconnectGeneration: 1,
    token: { accessToken: encryptToken('access-token', keyring).ciphertext },
    scopes: [],
  };
}

describe('Comment/reply idempotency gap closure', () => {
  it('T03 CREATE_COMMENT provider success + local transaction failure redelivers as local-only commit', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const account = encryptedAccount(keyring);
    const createComment = vi.fn(async () => ({
      externalCommentId: 'remote_comment_1',
      postedAt: new Date('2026-08-10T00:00:00.000Z'),
    }));
    let operation = {
      id: 'operation_1',
      workspaceId: 'workspace_1',
      operationType: 'CREATE_COMMENT',
      resourceType: 'CommentCreateCommand',
      resourceId: 'command_1',
      state: 'PREPARED',
      attemptId: null as string | null,
      fence: 0,
      remoteCheckpoint: null as unknown,
    };
    let localTransactionCalls = 0;
    const tx = {
      comment: { upsert: vi.fn(async () => ({ id: 'local_comment_1' })) },
      commentCreateCommand: { update: vi.fn(async () => ({})) },
      outboundOperation: {
        updateMany: vi.fn(async ({ where }) => {
          if (
            where.state === 'REMOTE_CONFIRMED' &&
            where.attemptId === operation.attemptId &&
            where.fence === operation.fence
          ) {
            operation = { ...operation, state: 'LOCAL_COMMITTED' };
            return { count: 1 };
          }
          return { count: 0 };
        }),
      },
    };
    const prisma = {
      platformPost: {
        findFirst: vi.fn(async () => ({
          id: 'platform_post_1',
          workspaceId: 'workspace_1',
          externalPostId: 'remote_post_1',
          socialAccount: account,
          contentPost: {},
        })),
      },
      commentCreateCommand: {
        findFirst: vi.fn(async () => ({
          id: 'command_1',
          workspaceId: 'workspace_1',
          platformPostId: 'platform_post_1',
          requestedByUserId: 'user_1',
          message: 'hello',
        })),
      },
      socialAccount: {
        findUnique: vi.fn(async () => ({ status: 'CONNECTED', disconnectGeneration: 1 })),
      },
      outboundOperation: {
        findUnique: vi.fn(async (args) =>
          args?.select?.remoteCheckpoint
            ? { remoteCheckpoint: operation.remoteCheckpoint }
            : operation,
        ),
        updateMany: vi.fn(async ({ where, data }) => {
          if (where.state === 'PREPARED' && operation.state === 'PREPARED') {
            operation = {
              ...operation,
              state: 'DISPATCHING',
              attemptId: data.attemptId,
              fence: data.fence,
            };
            return { count: 1 };
          }
          if (
            where.state === 'DISPATCHING' &&
            operation.state === 'DISPATCHING' &&
            where.attemptId === operation.attemptId &&
            where.fence === operation.fence
          ) {
            operation = {
              ...operation,
              state: 'REMOTE_CONFIRMED',
              remoteCheckpoint: data.remoteCheckpoint,
            };
            return { count: 1 };
          }
          return { count: 0 };
        }),
      },
      backgroundJob: { upsert: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
      $transaction: vi.fn(async (callback) => {
        localTransactionCalls += 1;
        if (localTransactionCalls === 1) throw new Error('local commit failed');
        return callback(tx);
      }),
    };
    const processor = createCreatePlatformCommentProcessor({
      prisma: prisma as never,
      keyring,
      adapterFactory: {
        forWorkspace: vi.fn(async () => ({
          adapters: { requireCapability: vi.fn(() => ({ createComment })) },
          release: vi.fn(),
        })),
      } as never,
    });
    const job = {
      id: 'job_1',
      attemptsMade: 0,
      opts: { attempts: 2 },
      data: {
        commandId: 'command_1',
        platformPostId: 'platform_post_1',
        socialAccountId: 'account_1',
        workspaceId: 'workspace_1',
        message: 'hello',
        requestedByUserId: 'user_1',
        correlationId: 'corr_1',
        operationId: 'operation_1',
      },
    };

    await expect(processor(job)).rejects.toThrow('local commit failed');
    await expect(processor({ ...job, id: 'job_2' })).resolves.toMatchObject({
      created: true,
      externalCommentId: 'remote_comment_1',
    });

    expect(createComment).toHaveBeenCalledTimes(1);
    expect(operation.state).toBe('LOCAL_COMMITTED');
  });

  it('T13/T20 duplicate outbox transport for the same CommentCreateCommand identity does not create twice remotely', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const account = encryptedAccount(keyring);
    const createComment = vi.fn(async () => ({
      externalCommentId: 'remote_comment_1',
      postedAt: new Date('2026-08-10T00:00:00.000Z'),
    }));
    let operation = {
      id: 'operation_1',
      workspaceId: 'workspace_1',
      operationType: 'CREATE_COMMENT',
      resourceType: 'CommentCreateCommand',
      resourceId: 'command_1',
      state: 'PREPARED',
      attemptId: null as string | null,
      fence: 0,
    };
    const prisma = {
      platformPost: {
        findFirst: vi.fn(async () => ({
          id: 'platform_post_1',
          workspaceId: 'workspace_1',
          externalPostId: 'remote_post_1',
          socialAccount: account,
          contentPost: {},
        })),
      },
      commentCreateCommand: {
        findFirst: vi.fn(async () => ({
          id: 'command_1',
          workspaceId: 'workspace_1',
          platformPostId: 'platform_post_1',
          requestedByUserId: 'user_1',
          message: 'hello',
        })),
      },
      socialAccount: {
        findUnique: vi.fn(async () => ({ status: 'CONNECTED', disconnectGeneration: 1 })),
      },
      outboundOperation: {
        findUnique: vi.fn(async () => operation),
        updateMany: vi.fn(async ({ where, data }) => {
          if (where.state === 'PREPARED' && operation.state === 'PREPARED') {
            operation = {
              ...operation,
              state: 'DISPATCHING',
              attemptId: data.attemptId,
              fence: data.fence,
            };
            return { count: 1 };
          }
          if (where.state === 'DISPATCHING' && operation.state === 'DISPATCHING') {
            operation = { ...operation, state: 'REMOTE_CONFIRMED' };
            return { count: 1 };
          }
          return { count: 0 };
        }),
      },
      backgroundJob: { upsert: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
      $transaction: vi.fn(async (callback) => {
        return await callback({
          comment: { upsert: vi.fn(async () => ({ id: 'local_comment_1' })) },
          commentCreateCommand: { update: vi.fn(async () => ({})) },
          outboundOperation: {
            updateMany: vi.fn(async () => {
              operation = { ...operation, state: 'LOCAL_COMMITTED' };
              return { count: 1 };
            }),
          },
        });
      }),
    };
    const processor = createCreatePlatformCommentProcessor({
      prisma: prisma as never,
      keyring,
      adapterFactory: {
        forWorkspace: vi.fn(async () => ({
          adapters: { requireCapability: vi.fn(() => ({ createComment })) },
          release: vi.fn(),
        })),
      } as never,
    });
    const job = {
      id: 'job_1',
      data: {
        commandId: 'command_1',
        platformPostId: 'platform_post_1',
        socialAccountId: 'account_1',
        workspaceId: 'workspace_1',
        message: 'hello',
        requestedByUserId: 'user_1',
        correlationId: 'corr_1',
        operationId: 'operation_1',
      },
    };

    await expect(processor(job)).resolves.toMatchObject({ created: true });
    await expect(processor({ ...job, id: 'job_2' })).resolves.toEqual({
      created: false,
      reason: 'LOCAL_COMMITTED',
    });

    expect(createComment).toHaveBeenCalledTimes(1);
  });

  it('T13 exact outbox dispatchedAt crash window redelivers same durable event without duplicate remote create', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const account = encryptedAccount(keyring);
    const createComment = vi.fn(async () => ({
      externalCommentId: 'remote_comment_1',
      postedAt: new Date('2026-08-10T00:00:00.000Z'),
    }));
    const queuedJobs: Array<{ name: string; data: unknown; options: unknown }> = [];
    let operation = {
      id: 'operation_1',
      workspaceId: 'workspace_1',
      operationType: 'CREATE_COMMENT',
      resourceType: 'CommentCreateCommand',
      resourceId: 'command_1',
      state: 'PREPARED',
      attemptId: null as string | null,
      fence: 0,
    };
    const outboxEvent = {
      id: 'outbox_1',
      topic: 'create-platform-comment',
      dispatchedAt: null as Date | null,
      claimedAt: new Date('2026-08-10T00:00:00.000Z') as Date | null,
      claimedBy: 'dispatcher_1' as string | null,
      payload: {
        queueName: 'create-platform-comment',
        jobName: 'create-platform-comment',
        jobId: 'create-platform-comment-outbound-operation_1',
        payload: {
          commandId: 'command_1',
          platformPostId: 'platform_post_1',
          socialAccountId: 'account_1',
          workspaceId: 'workspace_1',
          message: 'hello',
          requestedByUserId: 'user_1',
          correlationId: 'corr_1',
          operationId: 'operation_1',
        },
        options: { jobId: 'create-platform-comment-outbound-operation_1' },
      },
    };
    let dispatchedAtPersistenceAttempts = 0;
    const prisma = {
      platformPost: {
        findFirst: vi.fn(async () => ({
          id: 'platform_post_1',
          workspaceId: 'workspace_1',
          externalPostId: 'remote_post_1',
          socialAccount: account,
          contentPost: {},
        })),
      },
      commentCreateCommand: {
        findFirst: vi.fn(async () => ({
          id: 'command_1',
          workspaceId: 'workspace_1',
          platformPostId: 'platform_post_1',
          requestedByUserId: 'user_1',
          message: 'hello',
        })),
      },
      socialAccount: {
        findUnique: vi.fn(async () => ({ status: 'CONNECTED', disconnectGeneration: 1 })),
      },
      outboundOperation: {
        findUnique: vi.fn(async () => operation),
        updateMany: vi.fn(async ({ where, data }) => {
          if (where.state === 'PREPARED' && operation.state === 'PREPARED') {
            operation = {
              ...operation,
              state: 'DISPATCHING',
              attemptId: data.attemptId,
              fence: data.fence,
            };
            return { count: 1 };
          }
          if (where.state === 'DISPATCHING' && operation.state === 'DISPATCHING') {
            operation = { ...operation, state: 'REMOTE_CONFIRMED' };
            return { count: 1 };
          }
          return { count: 0 };
        }),
      },
      outboxEvent: {
        update: vi.fn(async ({ data }) => {
          if ('dispatchedAt' in data) {
            dispatchedAtPersistenceAttempts += 1;
            if (dispatchedAtPersistenceAttempts === 1) {
              throw new Error('crash before dispatchedAt persisted');
            }
            outboxEvent.dispatchedAt = data.dispatchedAt;
            outboxEvent.claimedAt = data.claimedAt;
            outboxEvent.claimedBy = data.claimedBy;
            return outboxEvent;
          }
          outboxEvent.claimedAt = data.claimedAt;
          outboxEvent.claimedBy = data.claimedBy;
          return outboxEvent;
        }),
      },
      backgroundJob: { upsert: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
      $transaction: vi.fn(async (callback) => {
        return await callback({
          comment: { upsert: vi.fn(async () => ({ id: 'local_comment_1' })) },
          commentCreateCommand: { update: vi.fn(async () => ({})) },
          outboundOperation: {
            updateMany: vi.fn(async () => {
              operation = { ...operation, state: 'LOCAL_COMMITTED' };
              return { count: 1 };
            }),
          },
        });
      }),
    };
    const registry = {
      getQueue: vi.fn(() => ({
        add: vi.fn(async (name, data, options) => {
          queuedJobs.push({ name, data, options });
        }),
      })),
    };

    await dispatchClaimedOutboxEvent(prisma as never, registry as never, outboxEvent as never);

    expect(queuedJobs).toHaveLength(1);
    expect(outboxEvent.dispatchedAt).toBeNull();

    outboxEvent.claimedAt = new Date('2026-08-10T00:02:00.000Z');
    outboxEvent.claimedBy = 'dispatcher_2';
    await dispatchClaimedOutboxEvent(prisma as never, registry as never, outboxEvent as never);

    expect(queuedJobs).toHaveLength(2);
    expect(outboxEvent.dispatchedAt).toBeInstanceOf(Date);

    const processor = createCreatePlatformCommentProcessor({
      prisma: prisma as never,
      keyring,
      adapterFactory: {
        forWorkspace: vi.fn(async () => ({
          adapters: { requireCapability: vi.fn(() => ({ createComment })) },
          release: vi.fn(),
        })),
      } as never,
    });

    await expect(processor({ id: 'job_1', data: queuedJobs[0]?.data })).resolves.toMatchObject({
      created: true,
    });
    await expect(processor({ id: 'job_2', data: queuedJobs[1]?.data })).resolves.toEqual({
      created: false,
      reason: 'LOCAL_COMMITTED',
    });

    expect(createComment).toHaveBeenCalledTimes(1);
  });

  it('T21 REPLY_COMMENT provider success + local transaction failure redelivers as local-only commit', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const account = encryptedAccount(keyring);
    const replyToComment = vi.fn(async () => ({
      externalReplyId: 'remote_reply_1',
      sentAt: new Date('2026-08-10T00:00:00.000Z'),
    }));
    let operation = {
      id: 'operation_1',
      workspaceId: 'workspace_1',
      operationType: 'REPLY_COMMENT',
      resourceType: 'CommentReply',
      resourceId: 'reply_1',
      state: 'PREPARED',
      attemptId: null as string | null,
      fence: 0,
      remoteCheckpoint: null as unknown,
    };
    let localTransactionCalls = 0;
    const prisma = {
      comment: {
        findFirst: vi.fn(async () => ({
          id: 'comment_1',
          workspaceId: 'workspace_1',
          platformPostId: 'platform_post_1',
          externalCommentId: 'remote_comment_1',
          parent: null,
          socialAccount: account,
          platformPost: {},
        })),
      },
      commentReply: { findFirst: vi.fn(async () => ({ id: 'reply_1' })), update: vi.fn() },
      socialAccount: {
        findUnique: vi.fn(async () => ({ status: 'CONNECTED', disconnectGeneration: 1 })),
      },
      outboundOperation: {
        findUnique: vi.fn(async (args) =>
          args?.select?.remoteCheckpoint
            ? { remoteCheckpoint: operation.remoteCheckpoint }
            : operation,
        ),
        updateMany: vi.fn(async ({ where, data }) => {
          if (where.state === 'PREPARED' && operation.state === 'PREPARED') {
            operation = {
              ...operation,
              state: 'DISPATCHING',
              attemptId: data.attemptId,
              fence: data.fence,
            };
            return { count: 1 };
          }
          if (where.state === 'DISPATCHING' && operation.state === 'DISPATCHING') {
            operation = {
              ...operation,
              state: 'REMOTE_CONFIRMED',
              remoteCheckpoint: data.remoteCheckpoint,
            };
            return { count: 1 };
          }
          return { count: 0 };
        }),
      },
      backgroundJob: { upsert: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
      $transaction: vi.fn(async (callback) => {
        localTransactionCalls += 1;
        if (localTransactionCalls === 1) throw new Error('reply local commit failed');
        return callback({
          commentReply: { update: vi.fn(async () => ({})) },
          comment: { update: vi.fn(async () => ({})), upsert: vi.fn(async () => ({})) },
          outboundOperation: {
            updateMany: vi.fn(async () => {
              operation = { ...operation, state: 'LOCAL_COMMITTED' };
              return { count: 1 };
            }),
          },
        });
      }),
    };
    const processor = createReplyPlatformCommentProcessor({
      prisma: prisma as never,
      keyring,
      adapterFactory: {
        forWorkspace: vi.fn(async () => ({
          adapters: { requireCapability: vi.fn(() => ({ replyToComment })) },
          release: vi.fn(),
        })),
      } as never,
    });
    const job = {
      id: 'job_1',
      attemptsMade: 0,
      opts: { attempts: 2 },
      data: {
        commentId: 'comment_1',
        workspaceId: 'workspace_1',
        message: 'reply',
        requestedByUserId: 'user_1',
        correlationId: 'corr_1',
        replyRecordId: 'reply_1',
        operationId: 'operation_1',
      },
    };

    await expect(processor(job)).rejects.toThrow('reply local commit failed');
    await expect(processor({ ...job, id: 'job_2' })).resolves.toMatchObject({
      replied: true,
      externalReplyId: 'remote_reply_1',
    });

    expect(replyToComment).toHaveBeenCalledTimes(1);
    expect(operation.state).toBe('LOCAL_COMMITTED');
  });

  it('T14 two workers racing the same PREPARED operation produce one dispatch owner and one provider call', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const account = encryptedAccount(keyring);
    const createComment = vi.fn(async () => ({
      externalCommentId: 'remote_comment_1',
      postedAt: new Date('2026-08-10T00:00:00.000Z'),
    }));
    let operation = {
      id: 'operation_1',
      workspaceId: 'workspace_1',
      operationType: 'CREATE_COMMENT',
      resourceType: 'CommentCreateCommand',
      resourceId: 'command_1',
      state: 'PREPARED',
      attemptId: null as string | null,
      fence: 0,
    };
    const prisma = {
      platformPost: {
        findFirst: vi.fn(async () => ({
          id: 'platform_post_1',
          workspaceId: 'workspace_1',
          externalPostId: 'remote_post_1',
          socialAccount: account,
          contentPost: {},
        })),
      },
      commentCreateCommand: {
        findFirst: vi.fn(async () => ({
          id: 'command_1',
          workspaceId: 'workspace_1',
          platformPostId: 'platform_post_1',
          requestedByUserId: 'user_1',
          message: 'hello',
        })),
      },
      socialAccount: {
        findUnique: vi.fn(async () => ({ status: 'CONNECTED', disconnectGeneration: 1 })),
      },
      outboundOperation: {
        findUnique: vi.fn(async () => ({ ...operation })),
        updateMany: vi.fn(async ({ where, data }) => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          if (where.state === 'PREPARED' && operation.state === 'PREPARED') {
            operation = {
              ...operation,
              state: 'DISPATCHING',
              attemptId: data.attemptId,
              fence: data.fence,
            };
            return { count: 1 };
          }
          if (where.state === 'DISPATCHING' && operation.state === 'DISPATCHING') {
            operation = { ...operation, state: 'REMOTE_CONFIRMED' };
            return { count: 1 };
          }
          return { count: 0 };
        }),
      },
      backgroundJob: { upsert: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
      $transaction: vi.fn(async (callback) =>
        callback({
          comment: { upsert: vi.fn(async () => ({ id: 'local_comment_1' })) },
          commentCreateCommand: { update: vi.fn(async () => ({})) },
          outboundOperation: { updateMany: vi.fn(async () => ({ count: 1 })) },
        }),
      ),
    };
    const processor = createCreatePlatformCommentProcessor({
      prisma: prisma as never,
      keyring,
      adapterFactory: {
        forWorkspace: vi.fn(async () => ({
          adapters: { requireCapability: vi.fn(() => ({ createComment })) },
          release: vi.fn(),
        })),
      } as never,
    });
    const payload = {
      commandId: 'command_1',
      platformPostId: 'platform_post_1',
      socialAccountId: 'account_1',
      workspaceId: 'workspace_1',
      message: 'hello',
      requestedByUserId: 'user_1',
      correlationId: 'corr_1',
      operationId: 'operation_1',
    };

    const results = await Promise.allSettled([
      processor({ id: 'job_a', data: payload }),
      processor({ id: 'job_b', data: payload }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(createComment).toHaveBeenCalledTimes(1);
  });

  it('T17 BEFORE_CONNECT rollback CAS loss re-reads state and does not blind retry', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const account = encryptedAccount(keyring);
    const createComment = vi.fn(async () => {
      throw new RemoteRequestError('connect failed', 'BEFORE_CONNECT', false);
    });
    const outboundFindUnique = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'operation_1',
        workspaceId: 'workspace_1',
        operationType: 'CREATE_COMMENT',
        resourceType: 'CommentCreateCommand',
        resourceId: 'command_1',
        state: 'PREPARED',
        attemptId: null,
        fence: 0,
      })
      .mockResolvedValueOnce({
        id: 'operation_1',
        workspaceId: 'workspace_1',
        operationType: 'CREATE_COMMENT',
        resourceType: 'CommentCreateCommand',
        resourceId: 'command_1',
        state: 'REMOTE_UNKNOWN',
        attemptId: 'newer_attempt',
        fence: 2,
      });
    const outboundUpdateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const processor = createCreatePlatformCommentProcessor({
      prisma: {
        platformPost: {
          findFirst: vi.fn(async () => ({
            id: 'platform_post_1',
            workspaceId: 'workspace_1',
            externalPostId: 'remote_post_1',
            socialAccount: account,
            contentPost: {},
          })),
        },
        commentCreateCommand: {
          findFirst: vi.fn(async () => ({
            id: 'command_1',
            workspaceId: 'workspace_1',
            platformPostId: 'platform_post_1',
            requestedByUserId: 'user_1',
            message: 'hello',
          })),
        },
        socialAccount: {
          findUnique: vi.fn(async () => ({ status: 'CONNECTED', disconnectGeneration: 1 })),
        },
        outboundOperation: { findUnique: outboundFindUnique, updateMany: outboundUpdateMany },
        backgroundJob: { upsert: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
      } as never,
      keyring,
      adapterFactory: {
        forWorkspace: vi.fn(async () => ({
          adapters: { requireCapability: vi.fn(() => ({ createComment })) },
          release: vi.fn(),
        })),
      } as never,
    });

    await expect(
      processor({
        id: 'job_1',
        data: {
          commandId: 'command_1',
          platformPostId: 'platform_post_1',
          socialAccountId: 'account_1',
          workspaceId: 'workspace_1',
          message: 'hello',
          requestedByUserId: 'user_1',
          correlationId: 'corr_1',
          operationId: 'operation_1',
        },
      }),
    ).rejects.toThrow('connect failed');

    expect(createComment).toHaveBeenCalledTimes(1);
    expect(outboundUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ state: 'DISPATCHING' }),
        data: expect.objectContaining({ state: 'PREPARED' }),
      }),
    );
    expect(outboundFindUnique).toHaveBeenLastCalledWith(
      expect.objectContaining({
        select: { id: true, state: true, attemptId: true, fence: true },
      }),
    );
  });

  it('P0-G create-comment REMOTE_UNKNOWN redelivery transitions command and operation to MANUAL_REVIEW without remote retry', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const account = encryptedAccount(keyring);
    const createComment = vi.fn();
    const tx = {
      outboundOperation: { updateMany: vi.fn(async () => ({ count: 1 })) },
      commentCreateCommand: { update: vi.fn(async () => ({})) },
    };
    const prisma = {
      platformPost: {
        findFirst: vi.fn(async () => ({
          id: 'platform_post_1',
          workspaceId: 'workspace_1',
          externalPostId: 'remote_post_1',
          socialAccount: account,
          contentPost: {},
        })),
      },
      commentCreateCommand: {
        findFirst: vi.fn(async () => ({
          id: 'command_1',
          workspaceId: 'workspace_1',
          platformPostId: 'platform_post_1',
          requestedByUserId: 'user_1',
          message: 'hello',
        })),
      },
      outboundOperation: {
        findUnique: vi.fn(async () => ({
          id: 'operation_1',
          workspaceId: 'workspace_1',
          operationType: 'CREATE_COMMENT',
          resourceType: 'CommentCreateCommand',
          resourceId: 'command_1',
          state: 'REMOTE_UNKNOWN',
          attemptId: 'attempt_1',
          fence: 2,
        })),
      },
      backgroundJob: { upsert: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
      $transaction: vi.fn(async (callback) => callback(tx)),
    };
    const processor = createCreatePlatformCommentProcessor({
      prisma: prisma as never,
      keyring,
      adapterFactory: {
        forWorkspace: vi.fn(async () => ({
          adapters: { requireCapability: vi.fn(() => ({ createComment })) },
          release: vi.fn(),
        })),
      } as never,
    });

    await expect(
      processor({
        id: 'job_1',
        data: {
          commandId: 'command_1',
          platformPostId: 'platform_post_1',
          socialAccountId: 'account_1',
          workspaceId: 'workspace_1',
          message: 'hello',
          requestedByUserId: 'user_1',
          correlationId: 'corr_1',
          operationId: 'operation_1',
        },
      }),
    ).resolves.toEqual({ created: false, reason: 'MANUAL_REVIEW' });

    expect(createComment).not.toHaveBeenCalled();
    expect(tx.outboundOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'operation_1', state: 'REMOTE_UNKNOWN' },
        data: expect.objectContaining({ state: 'MANUAL_REVIEW' }),
      }),
    );
    expect(tx.commentCreateCommand.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'command_1' },
        data: expect.objectContaining({ status: 'MANUAL_REVIEW' }),
      }),
    );
  });

  it('P0-G reply REMOTE_UNKNOWN redelivery transitions reply and operation to MANUAL_REVIEW without remote retry', async () => {
    const keyring = Keyring.fromEnv(`v1:${Keyring.generateKey()}`, 'v1');
    const account = encryptedAccount(keyring);
    const replyToComment = vi.fn();
    const tx = {
      outboundOperation: { updateMany: vi.fn(async () => ({ count: 1 })) },
      commentReply: { update: vi.fn(async () => ({})) },
    };
    const prisma = {
      comment: {
        findFirst: vi.fn(async () => ({
          id: 'comment_1',
          workspaceId: 'workspace_1',
          externalCommentId: 'remote_comment_1',
          parent: null,
          socialAccount: account,
          platformPost: { id: 'platform_post_1' },
        })),
      },
      commentReply: {
        findFirst: vi.fn(async () => ({
          id: 'reply_1',
          workspaceId: 'workspace_1',
          commentId: 'comment_1',
          message: 'reply',
          status: 'PENDING',
        })),
      },
      outboundOperation: {
        findUnique: vi.fn(async () => ({
          id: 'operation_1',
          workspaceId: 'workspace_1',
          operationType: 'REPLY_COMMENT',
          resourceType: 'CommentReply',
          resourceId: 'reply_1',
          state: 'REMOTE_UNKNOWN',
          attemptId: 'attempt_1',
          fence: 2,
        })),
      },
      backgroundJob: { upsert: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
      $transaction: vi.fn(async (callback) => callback(tx)),
    };
    const processor = createReplyPlatformCommentProcessor({
      prisma: prisma as never,
      keyring,
      adapterFactory: {
        forWorkspace: vi.fn(async () => ({
          adapters: { requireCapability: vi.fn(() => ({ replyToComment })) },
          release: vi.fn(),
        })),
      } as never,
    });

    await expect(
      processor({
        id: 'job_1',
        data: {
          commentId: 'comment_1',
          replyRecordId: 'reply_1',
          socialAccountId: 'account_1',
          workspaceId: 'workspace_1',
          message: 'reply',
          requestedByUserId: 'user_1',
          correlationId: 'corr_1',
          operationId: 'operation_1',
        },
      }),
    ).resolves.toEqual({ replied: false, reason: 'MANUAL_REVIEW' });

    expect(replyToComment).not.toHaveBeenCalled();
    expect(tx.outboundOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'operation_1', state: 'REMOTE_UNKNOWN' },
        data: expect.objectContaining({ state: 'MANUAL_REVIEW' }),
      }),
    );
    expect(tx.commentReply.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'reply_1' },
        data: expect.objectContaining({ status: 'MANUAL_REVIEW' }),
      }),
    );
  });
});
