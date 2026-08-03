import {
  computeEngagementRate,
  emptyPostMetrics,
  metricFromApi,
  type PlatformMetricMap,
  type PlatformMetricValue,
} from '@socialhub/shared';
import { getCapabilityTable } from '../capabilities/matrix';
import type { SocialPlatformAdapter } from '../core/adapter.interface';
import type {
  AdapterContext,
  AuthUrlInput,
  EditPostInput,
  ExternalPost,
  ExternalPostPage,
  PinterestBoardSectionSummary,
  PinterestBoardSummary,
  PostMetrics,
  PublishPostInput,
  PublishResult,
  SocialAccountProfile,
  SyncPostsParams,
  TokenSet,
} from '../core/types';
import { mapPinterestProfile, mapPinterestToken } from './pinterest.mapper';
import {
  PinterestClient,
  type PinterestApiEnvironment,
  type PinterestClientConfig,
} from './pinterest.client';
import type { PinterestPin, PinterestPinAnalyticsResponse } from './pinterest.schemas';
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
const PINTEREST_ANALYTICS_METRICS = [
  'IMPRESSION',
  'SAVE',
  'SAVE_RATE',
  'PIN_CLICK',
  'PIN_CLICK_RATE',
  'OUTBOUND_CLICK',
  'OUTBOUND_CLICK_RATE',
  'ENGAGEMENT',
  'ENGAGEMENT_RATE',
  'TOTAL_REACTIONS',
  'VIDEO_MRC_VIEW',
  'VIDEO_10S_VIEW',
  'VIDEO_AVG_WATCH_TIME',
  'VIDEO_V50_WATCH_TIME',
  'VIDEO_V95_WATCHED',
] as const;

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

  async listBoards(ctx: AdapterContext): Promise<PinterestBoardSummary[]> {
    const boards = await this.client.listBoards(ctx.accessToken);
    return boards.map((board) => ({
      id: board.id,
      name: board.name,
      description: board.description,
      privacy: board.privacy,
      ownerUsername: board.owner?.username,
    }));
  }

  async listBoardSections(
    ctx: AdapterContext,
    boardId: string,
  ): Promise<PinterestBoardSectionSummary[]> {
    const sections: PinterestBoardSectionSummary[] = [];
    let bookmark: string | undefined;

    do {
      const response = await this.client.listBoardSections(ctx.accessToken, boardId, {
        bookmark,
        pageSize: 25,
      });
      sections.push(...response.items.map((item) => ({ id: item.id, name: item.name })));
      bookmark = response.bookmark ?? undefined;
    } while (bookmark);

    return sections;
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

  async getPosts(ctx: AdapterContext, params: SyncPostsParams): Promise<ExternalPostPage> {
    const limit = clampPageSize(params.limit);
    const response = ctx.externalPageId
      ? await this.client.listPinsOnBoard({
          accessToken: ctx.accessToken,
          boardId: ctx.externalPageId,
          bookmark: params.cursor,
          pageSize: limit,
          pinMetrics: true,
        })
      : await this.client.listPins({
          accessToken: ctx.accessToken,
          bookmark: params.cursor,
          pageSize: limit,
          pinMetrics: true,
        });

    return {
      items: response.items.map(mapPinterestPin),
      nextCursor: response.bookmark ?? undefined,
      hasMore: Boolean(response.bookmark),
    };
  }

  async editPost(ctx: AdapterContext, externalPostId: string, input: EditPostInput): Promise<void> {
    const options = pinterestPublishOptions(input.options);
    const description = pinterestEditDescription(input);
    validatePinterestEdit(input, description);

    await this.client.updatePin({
      accessToken: ctx.accessToken,
      pinId: externalPostId,
      boardId: options.boardId,
      boardSectionId: options.boardSectionId,
      title: input.title?.trim() || undefined,
      description: description || undefined,
      link: input.linkUrl,
      altText: options.altText,
      aiDisclosures: options.aiDisclosures,
    });
  }

  async deletePost(ctx: AdapterContext, externalPostId: string): Promise<void> {
    await this.client.deletePin(ctx.accessToken, externalPostId);
  }

  async getPostMetrics(ctx: AdapterContext, externalPostId: string): Promise<PostMetrics> {
    const [pin, analytics] = await Promise.all([
      this.client.getPin({
        accessToken: ctx.accessToken,
        pinId: externalPostId,
        pinMetrics: true,
      }),
      this.client.getPinAnalytics({
        accessToken: ctx.accessToken,
        pinId: externalPostId,
        ...pinterestLast90Days(),
        metricTypes: [...PINTEREST_ANALYTICS_METRICS],
      }),
    ]);

    return mapPinterestMetrics(pin, analytics);
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

function pinterestEditDescription(input: EditPostInput): string {
  return [input.description ?? input.caption, input.hashtags?.map((tag) => `#${tag}`).join(' ')]
    .filter(Boolean)
    .join('\n\n');
}

function validatePinterestEdit(input: EditPostInput, description: string): void {
  const issues: string[] = [];
  if ((input.title?.length ?? 0) > 100) issues.push('title: Pinterest title tối đa 100 ký tự.');
  if (description.length > 800) {
    issues.push('description: Pinterest description tối đa 800 ký tự.');
  }
  if (input.linkUrl && !isValidHttpUrl(input.linkUrl)) {
    issues.push('linkUrl: Pinterest link phải là URL http:// hoặc https:// hợp lệ.');
  }
  if (issues.length > 0) throw new Error(issues.join('; '));
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function clampPageSize(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return 25;
  return Math.min(250, Math.max(1, Math.floor(value)));
}

function mapPinterestPin(pin: PinterestPin): ExternalPost {
  const title = pin.title?.trim();
  const description = pin.description?.trim();
  return {
    externalPostId: pin.id,
    title: title || undefined,
    caption: description || title || undefined,
    permalink: `https://www.pinterest.com/pin/${pin.id}/`,
    publishedAt: pin.created_at ? new Date(pin.created_at) : new Date(),
    media: [
      {
        url: `https://www.pinterest.com/pin/${pin.id}/`,
        thumbnailUrl: pickPinterestThumbnail(pin),
        type: mapPinterestMediaType(pin) ?? 'IMAGE',
      },
    ],
    raw: pin,
  };
}

function mapPinterestMediaType(pin: PinterestPin) {
  const mediaType = pin.media?.media_type?.toLowerCase();
  const creativeType = pin.creative_type?.toLowerCase();
  if (mediaType?.includes('video') || creativeType?.includes('video')) return 'VIDEO' as const;
  if (mediaType?.includes('image') || pin.media?.images) return 'IMAGE' as const;
  return undefined;
}

function pickPinterestThumbnail(pin: PinterestPin): string | undefined {
  const images = pin.media?.images;
  if (!images) return undefined;
  return (
    images['600x']?.url ??
    images['400x300']?.url ??
    images['1200x']?.url ??
    images['150x150']?.url ??
    Object.values(images)[0]?.url
  );
}

function mapPinterestMetrics(
  pin: PinterestPin,
  analytics: PinterestPinAnalyticsResponse,
): PostMetrics {
  const metrics = emptyPostMetrics('UNSUPPORTED');
  const summary = mergePinterestAnalytics(analytics);
  const lifetime = pin.pin_metrics?.lifetime_metrics;
  const rolling90d = pin.pin_metrics?.['90d'];

  const impressions = metricValue(summary, 'IMPRESSION') ?? metricValue(lifetime, 'impression');
  const saves = metricValue(summary, 'SAVE') ?? metricValue(lifetime, 'save');
  const pinClicks = metricValue(summary, 'PIN_CLICK') ?? metricValue(lifetime, 'pin_click');
  const outboundClicks =
    metricValue(summary, 'OUTBOUND_CLICK') ?? metricValue(lifetime, 'clickthrough');
  const reactions = metricValue(summary, 'TOTAL_REACTIONS') ?? metricValue(lifetime, 'reaction');
  const comments = metricValue(lifetime, 'comment') ?? metricValue(rolling90d, 'comment');
  const videoViews =
    metricValue(summary, 'VIDEO_MRC_VIEW') ?? metricValue(summary, 'VIDEO_10S_VIEW');
  const engagement =
    metricValue(summary, 'ENGAGEMENT') ??
    sumNumbers([saves, pinClicks, outboundClicks, reactions, comments]);

  if (impressions !== undefined) metrics.impressions = metricFromApi(impressions);
  if (saves !== undefined) metrics.saves = metricFromApi(saves);
  if (reactions !== undefined) metrics.likes = metricFromApi(reactions);
  if (comments !== undefined) metrics.comments = metricFromApi(comments);
  if (videoViews !== undefined) metrics.views = metricFromApi(videoViews);
  if (engagement !== undefined) metrics.engagement = metricFromApi(engagement);
  metrics.engagementRate = computeEngagementRate(metrics);
  metrics.raw = {
    pin,
    analytics,
    normalized: {
      impressions: impressions ?? null,
      saves: saves ?? null,
      pinClicks: pinClicks ?? null,
      outboundClicks: outboundClicks ?? null,
      reactions: reactions ?? null,
      comments: comments ?? null,
      videoViews: videoViews ?? null,
      engagement: engagement ?? null,
    },
    platformMetrics: pinterestPlatformMetrics(summary, lifetime, rolling90d),
  };

  return metrics;
}

function mergePinterestAnalytics(response: PinterestPinAnalyticsResponse): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const entry of Object.values(response)) {
    Object.assign(merged, entry.lifetime_metrics, entry.summary_metrics);
  }
  return merged;
}

function metricValue(values: Record<string, number> | undefined, key: string): number | undefined {
  const value = values?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sumNumbers(values: Array<number | undefined>): number | undefined {
  const usable = values.filter((value): value is number => value !== undefined);
  if (usable.length === 0) return undefined;
  return usable.reduce((sum, value) => sum + value, 0);
}

function pinterestPlatformMetrics(
  summary: Record<string, number>,
  lifetime: Record<string, number> | undefined,
  rolling90d: Record<string, number> | undefined,
): PlatformMetricMap {
  const metrics: PlatformMetricMap = {};
  for (const [key, value] of Object.entries({ ...rolling90d, ...lifetime, ...summary })) {
    addPinterestPlatformMetric(
      metrics,
      key,
      pinterestMetricLabel(key),
      value,
      pinterestMetricUnit(key),
      pinterestMetricGroup(key),
    );
  }
  return metrics;
}

function addPinterestPlatformMetric(
  target: PlatformMetricMap,
  key: string,
  label: string,
  value: PlatformMetricValue['value'],
  unit: PlatformMetricValue['unit'],
  group: string,
): void {
  target[key] = {
    key,
    label,
    value,
    unit,
    group,
    source: value === null ? 'NOT_SYNCED' : 'PLATFORM_API',
  };
}

function pinterestMetricLabel(key: string): string {
  return key
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function pinterestMetricUnit(key: string): PlatformMetricValue['unit'] {
  if (key.includes('RATE')) return 'percent';
  if (key.includes('WATCH_TIME')) return 'seconds';
  return 'count';
}

function pinterestMetricGroup(key: string): string {
  if (key.includes('VIDEO')) return 'Video';
  if (key.includes('CLICK')) return 'Traffic';
  if (key.includes('SAVE') || key.includes('REACTION') || key.includes('ENGAGEMENT')) {
    return 'Engagement';
  }
  return 'Distribution';
}

function pinterestLast90Days(): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 89);
  return {
    startDate: isoDate(start),
    endDate: isoDate(end),
  };
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function fileNameFromMediaUrl(value: string, fallback: string): string {
  const clean = value.split('?')[0]?.split('/').pop();
  return clean && clean.includes('.') ? clean : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
