/**
 * Security headers — SECURITY.md §9.
 *
 * CSP ở đây quan trọng hơn ở API: đây là nơi thực sự render HTML và chạy
 * JavaScript trong trình duyệt người dùng. Nội dung comment lấy từ các nền tảng
 * là dữ liệu KHÔNG TIN CẬY, và CSP là lớp phòng thủ cuối cùng nếu escaping của
 * React bị bỏ qua ở đâu đó.
 *
 * `'unsafe-inline'` cho style là nhượng bộ cần thiết cho Tailwind/Next; cho
 * script thì KHÔNG — sẽ dùng nonce khi cần script inline.
 */
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' http://localhost:4000 https:",
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
  transpilePackages: ['@socialhub/shared'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
