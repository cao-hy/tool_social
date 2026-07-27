import nextEnv from '@next/env';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { loadEnvConfig } = nextEnv;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
loadEnvConfig(repoRoot);
const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

/**
 * Security headers — SECURITY.md §9.
 *
 * CSP ở đây quan trọng hơn ở API: đây là nơi thực sự render HTML và chạy
 * JavaScript trong trình duyệt người dùng. Nội dung comment lấy từ các nền tảng
 * là dữ liệu KHÔNG TIN CẬY, và CSP là lớp phòng thủ cuối cùng nếu escaping của
 * React bị bỏ qua ở đâu đó.
 *
 * Ở development, Next cần inline script cho runtime/HMR nên CSP được nới vừa
 * đủ để local dev không trắng màn hình. Production sẽ cần nonce trước khi bật
 * CSP script strict hoàn toàn.
 */
const isDevelopment = process.env.NODE_ENV !== 'production';

const csp = [
  "default-src 'self'",
  isDevelopment
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-eval'",
  isDevelopment
    ? "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com"
    : "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  isDevelopment ? "font-src 'self' data: https://fonts.gstatic.com" : "font-src 'self' data:",
  isDevelopment
    ? "connect-src 'self' http://localhost:3000 ws://localhost:3000 http://localhost:4000 https:"
    : "connect-src 'self' http://localhost:4000 https:",
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
