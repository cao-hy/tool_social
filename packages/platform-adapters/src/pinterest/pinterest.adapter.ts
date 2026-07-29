import { emptyPostMetrics, type Paginated } from '@socialhub/shared';
import { getCapabilityTable } from '../capabilities/matrix';
import { capabilityUnsupported } from '../core/platform-error';
import type { SocialPlatformAdapter } from '../core/adapter.interface';
import type {
  AdapterContext,
  AuthUrlInput,
  PlatformPostData,
  PostMetrics,
  PublishPostInput,
  PublishResult,
  SocialAccountProfile,
  TokenSet,
} from '../core/types';
import { mapPinterestProfile, mapPinterestToken } from './pinterest.mapper';
import {
  PinterestClient,
  type PinterestApiEnvironment,
  type PinterestClientConfig,
} from './pinterest.client';
import { pinterestDescription, validatePinterestPost } from './pinterest.validator';

export interface PinterestAdapterConfig extends PinterestClientConfig {
  scopes?: string[];
}

export const PINTEREST_OAUTH_SCOPES = [
  'user_accounts:read',
  'boards:read',
  'boards:write',
  'pins:read',
  'pins:write',
] as const;

const DEFAULT_BOARD_NAME = 'SocialHub';
const VIDEO_UPLOAD_POLL_ATTEMPTS = 24;
const VIDEO_UPLOAD_POLL_INTERVAL_MS = 5000;

export class PinterestAdapter implements SocialPlatformAdapter {
  readonly platform = 'PINTEREST' as const;
  readonly capabilities = getCapabilityTable('PINTEREST');

  private readonly client: PinterestClient;
  private readonly scopes: string[];
  private readonly defaultBoardName: string;
  private readonly environment: PinterestApiEnvironment;

  constructor(config: PinterestAdapterConfig) {
    this.client = new PinterestClient(config);
    this.scopes = config.scopes ?? [...PINTEREST_OAUTH_SCOPES];
    this.defaultBoardName = config.defaultBoardName ?? DEFAULT_BOARD_NAME;
    this.environment = config.environment ?? 'production';
  }

  buildAuthorizationUrl(input: AuthUrlInput): string {
    return this.client.buildAuthorizationUrl({
      redirectUri: input.redirectUri,
      state: input.state,
      scopes: input.scopes.length > 0 ? input.scopes : this.scopes,
    });
  }

  async exchangeCodeForToken(code: string, redirectUri: string): Promise<TokenSet> {
    const token = await this.client.exchangeCodeForToken(code, redirectUri);
    const account = await this.client.getUserAccount(token.access_token);
    const board = await this.client.ensureBoard(token.access_token, this.defaultBoardName);

    return mapPinterestToken({
      token,
      scopes: this.scopes,
      account,
      board,
    });
  }

  async refreshToken(refreshToken: string): Promise<TokenSet> {
    const token = await this.client.refreshToken(refreshToken);
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      accessTokenExpiresAt: token.expires_in
        ? new Date(Date.now() + token.expires_in * 1000)
        : undefined,
      refreshTokenExpiresAt: token.refresh_token_expires_at
        ? new Date(token.refresh_token_expires_at * 1000)
        : undefined,
      scopes: token.scope?.split(/[,\s]+/).filter(Boolean) ?? this.scopes,
      tokenType: token.token_type ?? 'bearer',
    };
  }

  async getAccountProfile(ctx: AdapterContext): Promise<SocialAccountProfile> {
    const account = await this.client.getUserAccount(ctx.accessToken);
    const board = ctx.externalPageId
      ? (await this.client.listBoards(ctx.accessToken)).find(
          (item) => item.id === ctx.externalPageId,
        )
      : undefined;
    return mapPinterestProfile(account, board);
  }

  validatePost(input: PublishPostInput) {
    const validation = validatePinterestPost(input);
    if (this.environment === 'sandbox' && input.media.some((item) => item.type === 'VIDEO')) {
      return {
        valid: false,
        issues: [
          ...validation.issues,
          {
            field: 'media.video',
            message:
              'Pinterest API Sandbox không hỗ trợ tạo video Pin. Dùng ảnh để test Trial access, hoặc nâng app lên Standard và dùng production API.',
          },
        ],
      };
    }
    return validation;
  }

  async publishPost(ctx: AdapterContext, input: PublishPostInput): Promise<PublishResult> {
    const validation = this.validatePost(input);
    if (!validation.valid) {
      throw new Error(
        validation.issues.map((issue) => `${issue.field}: ${issue.message}`).join('; '),
      );
    }

    const options = pinterestPublishOptions(input.options);
    const boardId = options.boardId ?? ctx.externalPageId ?? ctx.externalAccountId;
    const video = input.media.find((item) => item.type === 'VIDEO');
    if (video) {
      const cover = input.thumbnail ?? input.media.find((item) => item.type === 'IMAGE');
      if (!cover || !/^https?:\/\//.test(cover.url)) {
        throw new Error('Pinterest video cần cover image URL public.');
      }
      if (!video.bytes?.length) {
        throw new Error('Pinterest video cần bytes từ storage để upload.');
      }

      const upload = await this.client.registerVideoUpload(ctx.accessToken);
      await this.client.uploadVideoToPinterestStorage({
        uploadUrl: upload.upload_url,
        uploadParameters: upload.upload_parameters,
        bytes: video.bytes,
        fileName: fileNameFromMediaUrl(video.url, 'video.mp4'),
        mimeType: video.mimeType,
      });
      await this.waitForVideoUpload(ctx.accessToken, upload.media_id);

      const result = await this.client.createVideoPin({
        accessToken: ctx.accessToken,
        boardId,
        boardSectionId: options.boardSectionId,
        title: input.title,
        description: pinterestDescription(input) || undefined,
        link: input.linkUrl,
        aiDisclosures: options.aiDisclosures,
        mediaId: upload.media_id,
        coverImageUrl: cover.url,
      });

      return {
        externalPostId: result.id,
        externalUrl: `https://www.pinterest.com/pin/${result.id}/`,
        publishedAt: result.created_at ? new Date(result.created_at) : new Date(),
      };
    }

    const image = input.media[0];
    if (!image || image.type !== 'IMAGE') {
      throw new Error('Pinterest cần đúng 1 ảnh hoặc 1 video để tạo Pin.');
    }
    const result = await this.client.createImagePin({
      accessToken: ctx.accessToken,
      boardId,
      boardSectionId: options.boardSectionId,
      title: input.title,
      description: pinterestDescription(input) || undefined,
      link: input.linkUrl,
      altText: options.altText ?? image.altText,
      dominantColor: options.dominantColor,
      aiDisclosures: options.aiDisclosures,
      image: image.bytes?.length
        ? {
            base64: Buffer.from(image.bytes).toString('base64'),
            contentType: image.mimeType,
          }
        : {
            url: image.url,
          },
    });

    return {
      externalPostId: result.id,
      externalUrl: `https://www.pinterest.com/pin/${result.id}/`,
      publishedAt: result.created_at ? new Date(result.created_at) : new Date(),
    };
  }

  private async waitForVideoUpload(accessToken: string, mediaId: string): Promise<void> {
    for (let attempt = 0; attempt < VIDEO_UPLOAD_POLL_ATTEMPTS; attempt += 1) {
      const details = await this.client.getMediaDetails(accessToken, mediaId);
      const status = details.status.toLowerCase();
      if (status === 'succeeded' || status === 'success' || status === 'completed') return;
      if (status === 'failed' || status === 'failure') {
        throw new Error(`Pinterest xử lý video thất bại: ${details.status}.`);
      }
      await sleep(VIDEO_UPLOAD_POLL_INTERVAL_MS);
    }
    throw new Error('Pinterest xử lý video quá thời gian chờ.');
  }

  async getPosts(): Promise<Paginated<PlatformPostData>> {
    throw capabilityUnsupported('PINTEREST', 'getPosts');
  }

  async getPostMetrics(_ctx: AdapterContext, _externalPostId: string): Promise<PostMetrics> {
    return emptyPostMetrics();
  }
}

function pinterestPublishOptions(options: Record<string, unknown> | undefined): {
  boardId?: string;
  boardSectionId?: string;
  altText?: string;
  dominantColor?: string;
  aiDisclosures?: string[];
} {
  return {
    boardId: readOptionalString(options?.boardId),
    boardSectionId: readOptionalString(options?.boardSectionId),
    altText: readOptionalString(options?.altText),
    dominantColor: readOptionalString(options?.dominantColor),
    aiDisclosures: Array.isArray(options?.aiDisclosures)
      ? options.aiDisclosures.filter((item): item is string => typeof item === 'string')
      : undefined,
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function fileNameFromMediaUrl(value: string, fallback: string): string {
  const clean = value.split('?')[0]?.split('/').pop();
  return clean && clean.includes('.') ? clean : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
