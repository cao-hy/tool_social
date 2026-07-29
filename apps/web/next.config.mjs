import nextEnv from '@next/env';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { loadEnvConfig } = nextEnv;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
loadEnvConfig(repoRoot);
const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';
const storageBaseUrl = process.env.S3_ENDPOINT ?? 'http://localhost:9000';

/**
 * Security headers — SECURITY.md §9.
 *
 * CSP ở đây quan trọng hơn ở API: đây là nơi thực sự render HTML và chạy
 * JavaScript trong trình duyệt người dùng. Nội dung comment lấy từ các nền tảng
 * là dữ liệu KHÔNG TIN CẬY, và CSP là lớp phòng thủ cuối cùng nếu escaping của
 * React bị bỏ qua ở đâu đó.
 *
 * Next App Router vẫn phát sinh một số inline bootstrap/hydration scripts.
 * Production muốn bỏ 'unsafe-inline' cần triển khai nonce/hash CSP riêng cho
 * toàn bộ response HTML; nếu không browser sẽ chặn runtime và trắng màn hình.
 */
const isDevelopment = process.env.NODE_ENV !== 'production';
const devConnectSources = [
  "'self'",
  'http://localhost:3000',
  'ws://localhost:3000',
  apiBaseUrl,
  storageBaseUrl,
  'http://127.0.0.1:3000',
  'ws://127.0.0.1:3000',
  'http://127.0.0.1:4000',
  'http://127.0.0.1:9000',
  'https:',
].join(' ');
const devMediaSources = [
  "'self'",
  'data:',
  'blob:',
  storageBaseUrl,
  'http://localhost:9000',
  'http://127.0.0.1:9000',
  'https:',
].join(' ');

const csp = [
  "default-src 'self'",
  isDevelopment
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'",
  isDevelopment
    ? "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com"
    : "style-src 'self' 'unsafe-inline'",
  isDevelopment ? `img-src ${devMediaSources}` : "img-src 'self' data: blob: https:",
  isDevelopment ? `media-src ${devMediaSources}` : "media-src 'self' blob: https:",
  isDevelopment ? "font-src 'self' data: https:" : "font-src 'self' data: https:",
  isDevelopment ? `connect-src ${devConnectSources}` : "connect-src 'self' https:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=()',
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  env: {
    NEXT_PUBLIC_API_BASE_URL: apiBaseUrl,
  },
  transpilePackages: ['@socialhub/shared'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
