import { describe, expect, it, vi } from 'vitest';
import { encryptToken, Keyring } from '@socialhub/security';
import { shouldUseStoreProxyForTarget } from '@socialhub/config';
import {
  cleanShopifyTargetUrl,
  normalizeShopAdminDomain,
  normalizeShortPathPrefix,
  normalizeUserProxyUrlInput,
  StoreIntegrationsService,
} from '../store-integrations.service';

const testKeyring = new Keyring([{ version: 'v1', key: Buffer.alloc(32, 7) }], 'v1');

describe('StoreIntegrationsService helpers & routing rules', () => {
  describe('normalizeShopAdminDomain', () => {
    it('normalizes bare handle, admin.shopify.com URL, and *.myshopify.com', () => {
      expect(normalizeShopAdminDomain('preaureum')).toBe('preaureum.myshopify.com');
      expect(
        normalizeShopAdminDomain('https://admin.shopify.com/store/preaureum/settings/apps'),
      ).toBe('preaureum.myshopify.com');
      expect(normalizeShopAdminDomain('https://PreAureum.myshopify.com/admin')).toBe(
        'preaureum.myshopify.com',
      );
    });

    it('rejects custom storefront domains on shopDomain to prevent 301 token stripping', () => {
      expect(() => normalizeShopAdminDomain('preaureum.com')).toThrow(/myshopify\.com/);
    });
  });

  describe('normalizeShortPathPrefix', () => {
    it('defaults to /s/ and rejects Shopify reserved paths', () => {
      expect(normalizeShortPathPrefix(undefined)).toBe('/s/');
      expect(normalizeShortPathPrefix('go')).toBe('/go/');
      expect(() => normalizeShortPathPrefix('/products/')).toThrow(/trùng đường dẫn hệ thống/);
    });
  });

  describe('normalizeUserProxyUrlInput', () => {
    it('converts host:port:user:pass and user:pass@host:port to http:// URLs', () => {
      expect(normalizeUserProxyUrlInput('45.134.95.39:53758:myuser:myp@ss')).toBe(
        'http://myuser:myp%40ss@45.134.95.39:53758',
      );
      expect(normalizeUserProxyUrlInput('user1:pass1@1.2.3.4:8080')).toBe(
        'http://user1:pass1@1.2.3.4:8080',
      );
      expect(normalizeUserProxyUrlInput('http://u:p@1.2.3.4:8080')).toBe('http://u:p@1.2.3.4:8080');
    });
  });

  describe('cleanShopifyTargetUrl', () => {
    it('strips tracking and Shopify search junk while preserving variant and discount params', () => {
      const dirty =
        'https://preaureum.com/products/silver-ring?variant=44991122&discount=PA10&_pos=1&_sid=abc&_ss=r&fbclid=IwAR123&utm_source=ig&utm_medium=social&pr_rec_id=999';
      expect(cleanShopifyTargetUrl(dirty, true)).toBe(
        'https://preaureum.com/products/silver-ring?variant=44991122&discount=PA10',
      );
    });
  });

  describe('shouldUseStoreProxyForTarget (Consistency Rule)', () => {
    it('routes ONLY checked targets when Store proxy is enabled, and Direct when disabled', () => {
      expect(
        shouldUseStoreProxyForTarget({ enabled: true, targets: ['TIKTOK', 'PINTEREST'] }, 'TIKTOK'),
      ).toBe(true);
      expect(
        shouldUseStoreProxyForTarget(
          { enabled: true, targets: ['TIKTOK', 'PINTEREST'] },
          'YOUTUBE',
        ),
      ).toBe(false);
      expect(
        shouldUseStoreProxyForTarget(
          { enabled: true, targets: ['TIKTOK', 'PINTEREST'] },
          'SHOPIFY',
        ),
      ).toBe(false);
      expect(
        shouldUseStoreProxyForTarget(
          { enabled: false, targets: ['TIKTOK', 'PINTEREST'] },
          'TIKTOK',
        ),
      ).toBe(false);
    });
  });

  describe('shortenStoreUrls', () => {
    it('skips already-shortened URLs, reuses DB cache, and creates Shopify redirect with collision retry', async () => {
      const encryptedShopifyToken = encryptToken('shpat_test_secret_token_1234', testKeyring);
      const shortLinksByTarget = new Map<
        string,
        {
          id: string;
          targetUrl: string;
          shopifyTarget: string;
          shortPath: string;
          shortUrl: string;
        }
      >();
      shortLinksByTarget.set('https://preaureum.com/products/cached-ring', {
        id: 'sl-cached',
        targetUrl: 'https://preaureum.com/products/cached-ring',
        shopifyTarget: '/products/cached-ring',
        shortPath: '/s/cached1',
        shortUrl: 'https://preaureum.com/s/cached1',
      });

      const prismaMock = {
        store: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'store-1',
            workspaceId: 'ws-1',
            name: 'PreAureum',
            shopifySetting: {
              enabled: true,
              shopDomain: 'preaureum.myshopify.com',
              publicDomain: 'preaureum.com',
              shortPathPrefix: '/s/',
              adminAccessToken: encryptedShopifyToken.ciphertext,
              encryptionKeyVersion: encryptedShopifyToken.keyVersion,
            },
          }),
        },
        storeShortLink: {
          findUnique: vi.fn().mockImplementation(async ({ where }) => {
            if (where.storeId_targetUrl) {
              return shortLinksByTarget.get(where.storeId_targetUrl.targetUrl) ?? null;
            }
            return null;
          }),
          upsert: vi.fn().mockImplementation(async ({ create }) => ({
            id: 'sl-new',
            ...create,
          })),
        },
      };

      let graphqlCallCount = 0;
      const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        graphqlCallCount += 1;
        const parsedBody = JSON.parse(String(init?.body ?? '{}')) as {
          variables?: { urlRedirect?: { path: string; target: string } };
        };
        if (graphqlCallCount === 1) {
          // Simulate collision on 1st attempt
          return new Response(
            JSON.stringify({
              data: {
                urlRedirectCreate: {
                  urlRedirect: null,
                  userErrors: [{ field: ['path'], message: 'Path has already been taken' }],
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            data: {
              urlRedirectCreate: {
                urlRedirect: {
                  id: 'gid://shopify/UrlRedirect/999',
                  path: parsedBody.variables?.urlRedirect?.path ?? '/s/new123',
                  target: parsedBody.variables?.urlRedirect?.target ?? '/products/new-ring',
                },
                userErrors: [],
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const releaseMock = vi.fn().mockResolvedValue(undefined);
      const adapterFactoryMock = {
        prepareTargetFetch: vi.fn().mockResolvedValue({
          fetch: fetchMock,
          proxy: { enabled: false },
          release: releaseMock,
        }),
      };

      const service = new StoreIntegrationsService(
        prismaMock as never,
        testKeyring,
        adapterFactoryMock as never,
        { record: vi.fn() } as never,
      );

      const res = await service.shortenStoreUrls('ws-1', 'store-1', 'user-1', {
        urls: [
          'https://preaureum.com/s/exist99',
          'https://preaureum.com/products/cached-ring?fbclid=junk123',
          'https://www.preaureum.com/products/new-ring?variant=123&_pos=2&utm_source=fb',
        ],
      });

      expect(adapterFactoryMock.prepareTargetFetch).toHaveBeenCalledWith(
        'ws-1',
        'store-1',
        'SHOPIFY',
      );
      expect(releaseMock).toHaveBeenCalledTimes(1);
      expect(res.items).toHaveLength(3);

      // 1. Already shortened -> untouched, 0 API calls
      expect(res.items[0]).toMatchObject({
        shortUrl: 'https://preaureum.com/s/exist99',
        reused: true,
        alreadyShort: true,
      });

      // 2. Cached after cleaning fbclid -> reused from DB
      expect(res.items[1]).toMatchObject({
        shortUrl: 'https://preaureum.com/s/cached1',
        reused: true,
      });

      // 3. New URL -> retried collision once, preserved variant=123, stripped _pos & utm_source
      expect(graphqlCallCount).toBe(2);
      expect(res.items[2]?.reused).toBe(false);
      expect(res.items[2]?.shortUrl).toMatch(/^https:\/\/preaureum\.com\/s\/[a-z0-9]{6}$/);
      expect(res.items[2]?.targetUrl).toBe('https://preaureum.com/products/new-ring?variant=123');
    });
  });
});
