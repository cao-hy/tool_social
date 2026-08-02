import { createHash } from 'node:crypto';
import { emptyPostMetrics, type Platform } from '@socialhub/shared';
import { createUnverifiedCapabilityTable } from '../core/capability-table';
import type { SocialPlatformAdapter } from '../core/adapter.interface';
import type {
  AdapterContext,
  AuthUrlInput,
  ExternalPostPage,
  PublishPostInput,
  SocialAccountProfile,
  TokenSet,
} from '../core/types';

function stableId(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Adapter local chỉ để kiểm thử Phase 3 end-to-end khi chưa có credential thật.
 *
 * Nó không gọi mạng, không chứng minh bất kỳ capability nào của nền tảng thật,
 * và capability table vẫn giữ UNVERIFIED. Production không được đăng ký adapter này.
 */
export class DevelopmentFixtureAdapter implements SocialPlatformAdapter {
  readonly capabilities;

  constructor(readonly platform: Platform) {
    this.capabilities = createUnverifiedCapabilityTable(platform);
  }

  buildAuthorizationUrl(input: AuthUrlInput): string {
    const url = new URL(input.redirectUri);
    url.searchParams.set('code', `dev-${this.platform.toLowerCase()}-${stableId(input.state)}`);
    url.searchParams.set('state', input.state);
    return url.toString();
  }

  async exchangeCodeForToken(
    code: string,
    _redirectUri: string,
    _codeVerifier?: string,
  ): Promise<TokenSet> {
    const suffix = stableId(`${this.platform}:${code}`);
    return {
      accessToken: `dev-access-${this.platform.toLowerCase()}-${suffix}`,
      refreshToken: `dev-refresh-${this.platform.toLowerCase()}-${suffix}`,
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      scopes: ['development-fixture'],
      tokenType: 'Bearer',
    };
  }

  async getAccountProfile(ctx: AdapterContext): Promise<SocialAccountProfile> {
    const suffix = stableId(`${this.platform}:${ctx.accessToken}`);
    return {
      externalAccountId: `dev-${this.platform.toLowerCase()}-${suffix}`,
      name: `${this.platform} dev account`,
      username: `dev_${this.platform.toLowerCase()}_${suffix.slice(0, 6)}`,
      profileUrl: 'https://example.test/socialhub-development-fixture',
    };
  }

  validatePost(_input: PublishPostInput) {
    return { valid: true, issues: [] };
  }

  async publishPost() {
    return {
      externalPostId: `dev-post-${Date.now().toString(36)}`,
      externalUrl: 'https://example.test/socialhub-development-fixture/post',
      publishedAt: new Date(),
    };
  }

  async getPosts(): Promise<ExternalPostPage> {
    return { items: [], hasMore: false };
  }

  async getPostMetrics() {
    return emptyPostMetrics();
  }
}
