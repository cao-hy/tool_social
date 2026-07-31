import { PLATFORM_LABELS, PLATFORMS } from './platform';

export type NetworkProxyMode = 'PROXY' | 'DIRECT';

export type NetworkPolicyCategory =
  'SOCIAL_ADAPTER' | 'SYSTEM_CHECK' | 'WEB_API' | 'STORAGE' | 'INFRASTRUCTURE';

export interface NetworkProxyPolicyItem {
  id: string;
  label: string;
  category: NetworkPolicyCategory;
  proxyMode: NetworkProxyMode;
  owner: string;
  operations: string[];
  source: string;
  note: string;
}

const SOCIAL_ADAPTER_POLICIES: NetworkProxyPolicyItem[] = PLATFORMS.map((platform) => ({
  id: `social-adapter.${platform.toLowerCase()}`,
  label: `${PLATFORM_LABELS[platform]} adapter API`,
  category: 'SOCIAL_ADAPTER',
  proxyMode: 'PROXY',
  owner: '@socialhub/platform-adapters',
  operations: [
    'OAuth token exchange / refresh / revoke',
    'Account profile fetch',
    'Publish / edit / delete post nếu nền tảng hỗ trợ',
    'Comment / metrics / status API nếu nền tảng hỗ trợ',
  ],
  source: 'createRuntimeAdapterRegistry({ fetch: createProxyAwareFetch() })',
  note: 'Mọi request đi qua social adapter client dùng proxy-aware fetch khi proxy được bật.',
}));

export const NETWORK_PROXY_POLICIES: readonly NetworkProxyPolicyItem[] = [
  ...SOCIAL_ADAPTER_POLICIES,
  {
    id: 'system.publish-network-proof',
    label: 'Publish network proof',
    category: 'SYSTEM_CHECK',
    proxyMode: 'PROXY',
    owner: '@socialhub/worker',
    operations: ['Kiểm tra IP ngay trước khi gọi API publish'],
    source: 'capturePublishNetworkProof()',
    note: 'Dùng cùng proxy-aware fetch với social adapter để chứng minh IP publish.',
  },
  {
    id: 'system.proxy-widget-network',
    label: 'Proxy widget network status',
    category: 'SYSTEM_CHECK',
    proxyMode: 'PROXY',
    owner: '@socialhub/api',
    operations: ['Kiểm tra IP hiển thị trong widget proxy'],
    source: 'SystemController.getNetworkStatus()',
    note: 'Cố ý dùng proxy-aware fetch để người dùng thấy IP social API sẽ dùng.',
  },
  {
    id: 'web.api-crud',
    label: 'Web app CRUD calls',
    category: 'WEB_API',
    proxyMode: 'DIRECT',
    owner: '@socialhub/web',
    operations: ['Auth', 'workspace', 'posts CRUD', 'inbox UI', 'settings UI'],
    source: 'apps/web/src/lib/api-client.ts',
    note: 'Browser gọi API của chính app; không đi qua proxy server.',
  },
  {
    id: 'storage.browser-upload',
    label: 'Browser media upload to MinIO',
    category: 'STORAGE',
    proxyMode: 'DIRECT',
    owner: '@socialhub/web',
    operations: ['PUT signed URL lên MinIO / media domain'],
    source: 'apps/web/src/app/(app)/posts/new/page.tsx',
    note: 'Upload media dùng network của trình duyệt tới media endpoint, không đi qua social proxy.',
  },
  {
    id: 'storage.worker-read-media',
    label: 'Worker read media from storage',
    category: 'STORAGE',
    proxyMode: 'DIRECT',
    owner: '@socialhub/worker',
    operations: ['Đọc object từ S3/MinIO trước khi upload binary lên nền tảng'],
    source: 'S3Client / GetObjectCommand',
    note: 'Đọc storage nội bộ phải đi direct để nhanh và tránh loop qua proxy.',
  },
  {
    id: 'infra.database-redis-queues',
    label: 'Database / Redis / BullMQ',
    category: 'INFRASTRUCTURE',
    proxyMode: 'DIRECT',
    owner: '@socialhub/api + @socialhub/worker',
    operations: ['Prisma queries', 'Redis session/cache', 'BullMQ jobs'],
    source: 'PrismaService / RedisService / QueueRegistry',
    note: 'Kết nối hạ tầng nội bộ không dùng HTTP fetch nên không đi qua proxy.',
  },
  {
    id: 'system.health-readiness',
    label: 'Health / readiness endpoints',
    category: 'SYSTEM_CHECK',
    proxyMode: 'DIRECT',
    owner: '@socialhub/api + @socialhub/worker',
    operations: ['/health', '/ready', 'worker health'],
    source: 'HealthController / worker health server',
    note: 'Health check chỉ đo tình trạng service nội bộ, không cần proxy.',
  },
] as const;

export function summarizeNetworkProxyPolicies(
  items: readonly NetworkProxyPolicyItem[] = NETWORK_PROXY_POLICIES,
) {
  const proxied = items.filter((item) => item.proxyMode === 'PROXY').length;
  const direct = items.filter((item) => item.proxyMode === 'DIRECT').length;
  return {
    total: items.length,
    proxied,
    direct,
  };
}
