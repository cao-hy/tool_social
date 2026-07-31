import { z } from 'zod';
import type { AdapterFetch } from '../core/types';
import { isPlatformError } from '../core/platform-error';
import {
  normalizePinterestError,
  pinterestNetworkError,
  pinterestUnexpectedPayloadError,
} from './pinterest.errors';
import {
  pinterestBoardsResponseSchema,
  pinterestBoardSchema,
  pinterestCreatePinResponseSchema,
  pinterestMediaDetailsResponseSchema,
  pinterestMediaUploadResponseSchema,
  pinterestPinAnalyticsResponseSchema,
  pinterestPinsResponseSchema,
  pinterestPinSchema,
  pinterestTokenResponseSchema,
  pinterestUserAccountSchema,
  type PinterestBoard,
  type PinterestCreatePinResponse,
  type PinterestMediaDetailsResponse,
  type PinterestMediaUploadResponse,
  type PinterestPin,
  type PinterestPinAnalyticsResponse,
  type PinterestPinsResponse,
  type PinterestTokenResponse,
  type PinterestUserAccount,
  pinterestBoardSectionSchema,
  pinterestBoardSectionsResponseSchema,
  pinterestSavePinResponseSchema,
  type PinterestBoardSection,
} from './pinterest.schemas';

export interface PinterestClientConfig {
  appId: string;
  appSecret: string;
  defaultBoardName?: string;
  environment?: PinterestApiEnvironment;
  fetch?: AdapterFetch;
}

export type PinterestApiEnvironment = 'production' | 'sandbox';

export class PinterestClient {
  private readonly apiBaseUrl: string;
  private readonly oauthUrl = 'https://www.pinterest.com/oauth/';
  private readonly fetch: AdapterFetch;

  constructor(private readonly config: PinterestClientConfig) {
    this.apiBaseUrl =
      config.environment === 'sandbox'
        ? 'https://api-sandbox.pinterest.com/v5'
        : 'https://api.pinterest.com/v5';
    this.fetch = config.fetch ?? fetch;
  }

  buildAuthorizationUrl(input: { redirectUri: string; state: string; scopes: string[] }): string {
    const url = new URL(this.oauthUrl);
    url.searchParams.set('client_id', this.config.appId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', input.scopes.join(','));
    url.searchParams.set('state', input.state);
    return url.toString();
  }

  exchangeCodeForToken(code: string, redirectUri: string): Promise<PinterestTokenResponse> {
    return this.postForm(
      '/oauth/token',
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        continuous_refresh: 'true',
      },
      pinterestTokenResponseSchema,
      true,
    );
  }

  refreshToken(refreshToken: string): Promise<PinterestTokenResponse> {
    return this.postForm(
      '/oauth/token',
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      },
      pinterestTokenResponseSchema,
      true,
    );
  }

  getUserAccount(accessToken: string): Promise<PinterestUserAccount> {
    return this.get('/user_account', {}, pinterestUserAccountSchema, accessToken);
  }

  async ensureBoard(accessToken: string, name: string): Promise<PinterestBoard> {
    const boards = await this.listBoards(accessToken);
    const existing = findBoardByName(boards, name);
    if (existing) return existing;

    try {
      return await this.createBoard(accessToken, name);
    } catch (error) {
      if (!isDuplicateBoardNameError(error)) throw error;
    }

    const refreshedBoards = await this.listBoards(accessToken);
    const refreshedExisting = findBoardByName(refreshedBoards, name);
    if (refreshedExisting) return refreshedExisting;

    for (const fallbackName of fallbackBoardNames(name)) {
      try {
        return await this.createBoard(accessToken, fallbackName);
      } catch (error) {
        if (!isDuplicateBoardNameError(error)) throw error;
      }
    }

    return this.createBoard(accessToken, `${name} ${Date.now().toString(36)}`);
  }

  async listBoards(accessToken: string): Promise<PinterestBoard[]> {
    const boards: PinterestBoard[] = [];
    let bookmark: string | undefined;

    do {
      const response = await this.get(
        '/boards',
        stripUndefined({
          page_size: '100',
          bookmark,
        }) as Record<string, string>,
        pinterestBoardsResponseSchema,
        accessToken,
      );
      boards.push(...response.items);
      bookmark = response.bookmark ?? undefined;
    } while (bookmark);

    return boards;
  }

  getBoard(accessToken: string, boardId: string): Promise<PinterestBoard> {
    return this.get(`/boards/${boardId}`, {}, pinterestBoardSchema, accessToken);
  }

  updateBoard(
    accessToken: string,
    boardId: string,
    input: { name?: string; description?: string; privacy?: string },
  ): Promise<PinterestBoard> {
    return this.patchJson(`/boards/${boardId}`, input, pinterestBoardSchema, accessToken);
  }

  deleteBoard(accessToken: string, boardId: string): Promise<void> {
    return this.delete(`/boards/${boardId}`, accessToken);
  }

  listBoardSections(
    accessToken: string,
    boardId: string,
    input?: { bookmark?: string; pageSize?: number },
  ): Promise<{ items: PinterestBoardSection[]; bookmark?: string | null }> {
    return this.get(
      `/boards/${boardId}/sections`,
      stripUndefined({
        page_size: input?.pageSize ? String(input.pageSize) : '25',
        bookmark: input?.bookmark,
      }) as Record<string, string>,
      pinterestBoardSectionsResponseSchema,
      accessToken,
    );
  }

  createBoardSection(
    accessToken: string,
    boardId: string,
    name: string,
  ): Promise<PinterestBoardSection> {
    return this.postJson(
      `/boards/${boardId}/sections`,
      { name },
      pinterestBoardSectionSchema,
      accessToken,
    );
  }

  updateBoardSection(
    accessToken: string,
    boardId: string,
    sectionId: string,
    name: string,
  ): Promise<PinterestBoardSection> {
    return this.patchJson(
      `/boards/${boardId}/sections/${sectionId}`,
      { name },
      pinterestBoardSectionSchema,
      accessToken,
    );
  }

  deleteBoardSection(accessToken: string, boardId: string, sectionId: string): Promise<void> {
    return this.delete(`/boards/${boardId}/sections/${sectionId}`, accessToken);
  }

  listPinsOnBoardSection(input: {
    accessToken: string;
    boardId: string;
    sectionId: string;
    bookmark?: string;
    pageSize?: number;
  }): Promise<PinterestPinsResponse> {
    return this.get(
      `/boards/${input.boardId}/sections/${input.sectionId}/pins`,
      stripUndefined({
        page_size: String(input.pageSize ?? 25),
        bookmark: input.bookmark,
      }) as Record<string, string>,
      pinterestPinsResponseSchema,
      input.accessToken,
    );
  }

  listPins(input: {
    accessToken: string;
    bookmark?: string;
    pageSize?: number;
    pinMetrics?: boolean;
  }): Promise<PinterestPinsResponse> {
    return this.get(
      '/pins',
      stripUndefined({
        page_size: String(input.pageSize ?? 25),
        bookmark: input.bookmark,
        pin_metrics: input.pinMetrics === true ? 'true' : undefined,
      }) as Record<string, string>,
      pinterestPinsResponseSchema,
      input.accessToken,
    );
  }

  listPinsOnBoard(input: {
    accessToken: string;
    boardId: string;
    bookmark?: string;
    pageSize?: number;
    pinMetrics?: boolean;
  }): Promise<PinterestPinsResponse> {
    return this.get(
      `/boards/${input.boardId}/pins`,
      stripUndefined({
        page_size: String(input.pageSize ?? 25),
        bookmark: input.bookmark,
        pin_metrics: input.pinMetrics === true ? 'true' : undefined,
      }) as Record<string, string>,
      pinterestPinsResponseSchema,
      input.accessToken,
    );
  }

  getPin(input: {
    accessToken: string;
    pinId: string;
    pinMetrics?: boolean;
  }): Promise<PinterestPin> {
    return this.get(
      `/pins/${input.pinId}`,
      stripUndefined({
        pin_metrics: input.pinMetrics === true ? 'true' : undefined,
      }) as Record<string, string>,
      pinterestPinSchema,
      input.accessToken,
    );
  }

  createImagePin(input: {
    accessToken: string;
    boardId: string;
    boardSectionId?: string;
    title?: string;
    description?: string;
    link?: string;
    altText?: string;
    dominantColor?: string;
    aiDisclosures?: string[];
    image: { base64?: string; url?: string; contentType?: string };
  }): Promise<PinterestCreatePinResponse> {
    const body: Record<string, unknown> = {
      board_id: input.boardId,
      board_section_id: input.boardSectionId,
      title: input.title,
      description: input.description,
      link: input.link,
      alt_text: input.altText,
      dominant_color: input.dominantColor,
      ai_disclosures: input.aiDisclosures?.length ? input.aiDisclosures : undefined,
      media_source: input.image.base64
        ? {
            source_type: 'image_base64',
            content_type: input.image.contentType ?? 'image/jpeg',
            data: input.image.base64,
            is_standard: true,
          }
        : {
            source_type: 'image_url',
            url: input.image.url,
            is_standard: true,
          },
    };

    return this.postJson('/pins', body, pinterestCreatePinResponseSchema, input.accessToken);
  }

  updatePin(input: {
    accessToken: string;
    pinId: string;
    boardId?: string;
    boardSectionId?: string;
    title?: string;
    description?: string;
    link?: string;
    altText?: string;
    aiDisclosures?: string[];
  }): Promise<PinterestPin> {
    return this.patchJson(
      `/pins/${input.pinId}`,
      {
        board_id: input.boardId,
        board_section_id: input.boardSectionId,
        title: input.title,
        description: input.description,
        link: input.link,
        alt_text: input.altText,
        ai_disclosures: input.aiDisclosures?.length ? { values: input.aiDisclosures } : undefined,
      },
      pinterestPinSchema,
      input.accessToken,
    );
  }

  deletePin(accessToken: string, pinId: string): Promise<void> {
    return this.delete(`/pins/${pinId}`, accessToken);
  }

  savePin(input: {
    accessToken: string;
    pinId: string;
    boardId: string;
    boardSectionId?: string;
  }): Promise<PinterestPin> {
    return this.postJson(
      `/pins/${input.pinId}/save`,
      {
        board_id: input.boardId,
        board_section_id: input.boardSectionId,
      },
      pinterestSavePinResponseSchema,
      input.accessToken,
    );
  }

  getPinAnalytics(input: {
    accessToken: string;
    pinId: string;
    startDate: string;
    endDate: string;
    metricTypes: string[];
  }): Promise<PinterestPinAnalyticsResponse> {
    return this.get(
      `/pins/${input.pinId}/analytics`,
      {
        start_date: input.startDate,
        end_date: input.endDate,
        app_types: 'ALL',
        metric_types: input.metricTypes.join(','),
        split_field: 'NO_SPLIT',
      },
      pinterestPinAnalyticsResponseSchema,
      input.accessToken,
    );
  }

  registerVideoUpload(accessToken: string): Promise<PinterestMediaUploadResponse> {
    return this.postJson(
      '/media',
      { media_type: 'video' },
      pinterestMediaUploadResponseSchema,
      accessToken,
    );
  }

  async uploadVideoToPinterestStorage(input: {
    uploadUrl: string;
    uploadParameters: Record<string, string>;
    bytes: Uint8Array;
    fileName: string;
    mimeType: string;
  }): Promise<void> {
    const form = new FormData();
    for (const [key, value] of Object.entries(input.uploadParameters)) {
      form.set(key, value);
    }
    form.set('file', new File([input.bytes], input.fileName, { type: input.mimeType }));

    let response: Response;
    try {
      response = await this.fetch(input.uploadUrl, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(180000),
      });
    } catch (error) {
      throw pinterestNetworkError(error);
    }

    if (!response.ok) {
      throw normalizePinterestError({
        status: response.status,
        payload: await parseJson(response),
        retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
      });
    }
  }

  getMediaDetails(accessToken: string, mediaId: string): Promise<PinterestMediaDetailsResponse> {
    return this.get(`/media/${mediaId}`, {}, pinterestMediaDetailsResponseSchema, accessToken);
  }

  createVideoPin(input: {
    accessToken: string;
    boardId: string;
    boardSectionId?: string;
    title?: string;
    description?: string;
    link?: string;
    aiDisclosures?: string[];
    mediaId: string;
    coverImageUrl: string;
  }): Promise<PinterestCreatePinResponse> {
    return this.postJson(
      '/pins',
      {
        board_id: input.boardId,
        board_section_id: input.boardSectionId,
        title: input.title,
        description: input.description,
        link: input.link,
        ai_disclosures: input.aiDisclosures?.length ? input.aiDisclosures : undefined,
        media_source: {
          source_type: 'video_id',
          media_id: input.mediaId,
          cover_image_url: input.coverImageUrl,
        },
      },
      pinterestCreatePinResponseSchema,
      input.accessToken,
    );
  }

  private async get<T>(
    path: string,
    params: Record<string, string>,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    accessToken: string,
  ): Promise<T> {
    const url = new URL(`${this.apiBaseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await this.fetch(url, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw pinterestNetworkError(error);
    }

    return parseResponse(response, schema);
  }

  private async postForm<T>(
    path: string,
    body: Record<string, string>,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    authenticated: boolean,
  ): Promise<T> {
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
    };
    if (authenticated) {
      headers.authorization = `Basic ${Buffer.from(
        `${this.config.appId}:${this.config.appSecret}`,
        'utf8',
      ).toString('base64')}`;
    }

    let response: Response;
    try {
      response = await this.fetch(`${this.apiBaseUrl}${path}`, {
        method: 'POST',
        headers,
        body: new URLSearchParams(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw pinterestNetworkError(error);
    }

    return parseResponse(response, schema);
  }

  private async postJson<T>(
    path: string,
    body: Record<string, unknown>,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    accessToken: string,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetch(`${this.apiBaseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(stripUndefined(body)),
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      throw pinterestNetworkError(error);
    }

    return parseResponse(response, schema);
  }

  private async patchJson<T>(
    path: string,
    body: Record<string, unknown>,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    accessToken: string,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetch(`${this.apiBaseUrl}${path}`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(stripUndefined(body)),
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      throw pinterestNetworkError(error);
    }

    return parseResponse(response, schema);
  }

  private async delete(path: string, accessToken: string): Promise<void> {
    let response: Response;
    try {
      response = await this.fetch(`${this.apiBaseUrl}${path}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      throw pinterestNetworkError(error);
    }

    await parseResponse(response, z.object({}).passthrough());
  }

  private createBoard(accessToken: string, name: string): Promise<PinterestBoard> {
    return this.postJson(
      '/boards',
      {
        name,
        description: 'Created by SocialHub Manager',
        privacy: 'PUBLIC',
      },
      pinterestBoardSchema,
      accessToken,
    );
  }
}

async function parseResponse<T>(
  response: Response,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<T> {
  const payload = await parseJson(response);
  if (!response.ok) {
    throw normalizePinterestError({
      status: response.status,
      payload,
      retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
    });
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw pinterestUnexpectedPayloadError(parsed.error, payload);
  return parsed.data;
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw pinterestUnexpectedPayloadError(error, { status: response.status, body: text });
  }
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return Math.max(0, date.getTime() - Date.now());
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function findBoardByName(boards: PinterestBoard[], name: string): PinterestBoard | undefined {
  return boards.find((board) => board.name.toLowerCase() === name.toLowerCase());
}

function fallbackBoardNames(name: string): string[] {
  const date = new Date().toISOString().slice(0, 10);
  return [`${name} Sandbox`, `${name} ${date}`];
}

function isDuplicateBoardNameError(error: unknown): boolean {
  if (!isPlatformError(error)) return false;
  if (error.platform !== 'PINTEREST' || error.kind !== 'VALIDATION') return false;
  return (
    error.platformCode === '58' ||
    error.message.toLowerCase().includes('already have a board with this name')
  );
}
