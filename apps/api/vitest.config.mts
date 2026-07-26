import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * NestJS dùng `emitDecoratorMetadata` để làm dependency injection theo kiểu.
 * esbuild (mặc định của Vitest) KHÔNG hỗ trợ tính năng đó, nên phải transform
 * bằng SWC — nếu không, mọi provider inject theo class sẽ nhận `undefined` với
 * thông báo lỗi rất khó hiểu.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    setupFiles: ['./vitest.setup.ts'],
    // Nest dựng app thật + Fastify: chậm hơn unit test thuần.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
