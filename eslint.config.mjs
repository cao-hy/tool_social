// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Flat config dùng chung cho toàn monorepo.
 *
 * Ghi chú kiến trúc (ARCHITECTURE.md §1, P1/P2):
 * khối `no-restricted-imports` ở cuối là cách duy nhất khiến ranh giới giữa các
 * package trở thành ràng buộc thực thi được, thay vì chỉ là quy ước trong tài liệu.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/generated/**',
      // Do Next.js sinh tự động và ghi đè mỗi lần build — lint nó là vô nghĩa.
      '**/next-env.d.ts',
      '**/*.config.js',
      '**/*.config.mjs',
      '**/*.config.cjs',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      /* prompt §19: không dùng `any` nếu không thực sự cần thiết */
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'off',

      /* prompt §21: không che lỗi */
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-throw-literal': 'error',
      'require-await': 'off',

      /* SECURITY.md §10: cấm đọc process.env ngoài packages/config */
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Đọc process.env trực tiếp bị cấm. Dùng @socialhub/config để env được validate lúc khởi động (ARCHITECTURE.md §11).',
        },
      ],
    },
  },

  /* packages/config LÀ nơi duy nhất được phép chạm vào process.env */
  {
    files: ['packages/config/**/*.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },

  /*
   * Script CLI độc lập (seed, migration helper) được chạy trực tiếp bằng
   * tsx/prisma, KHÔNG phải là một phần của process ứng dụng đang chạy. Chúng
   * không có bootstrap để gọi loadEnvOrExit, nên đọc process.env ở đây là đúng
   * chỗ chứ không phải lách luật.
   */
  {
    files: ['packages/db/prisma/**/*.ts', '**/scripts/**/*.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },

  /* Adapter là biên giới cứng — ARCHITECTURE.md §1 (P2) */
  {
    files: ['packages/platform-adapters/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@prisma/client', '@socialhub/db', '@socialhub/db/*'],
              message:
                'platform-adapters không được phụ thuộc vào tầng dữ liệu. Adapter nhận credential đã giải mã và trả dữ liệu đã chuẩn hóa; việc lưu trữ là của service (ARCHITECTURE.md §5).',
            },
            {
              group: ['@nestjs/*'],
              message:
                'platform-adapters phải là thư viện thuần TypeScript để test được mà không cần dựng DI container.',
            },
          ],
        },
      ],
    },
  },

  /* Social outbound code không được phép dùng createDirectFetch */
  {
    files: [
      'packages/platform-adapters/**/*.ts',
      'apps/worker/src/processors/**/*.ts',
      'apps/api/src/modules/posts/**/*.ts',
      'apps/api/src/modules/comments/**/*.ts',
      'apps/api/src/modules/social-accounts/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@socialhub/config',
              importNames: ['createDirectFetch'],
              message:
                'Social outbound traffic must use WorkspaceAdapterFactory (direct fetch bypasses proxy protection).',
            },
          ],
        },
      ],
    },
  },

  /* UI không được chứa logic nền tảng hay truy cập DB — prompt §19 */
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@prisma/client', '@socialhub/db', '@socialhub/db/*'],
              message: 'Frontend không được truy cập database trực tiếp. Gọi qua API.',
            },
            {
              group: ['@socialhub/platform-adapters/*'],
              message:
                'Frontend không được gọi platform API. Dùng @socialhub/shared cho type và capability.',
            },
            {
              group: ['@socialhub/security', '@socialhub/security/*'],
              message:
                'Frontend không bao giờ được chạm vào mã hóa token (SECURITY.md §2.3, quy tắc 1).',
            },
          ],
        },
      ],
    },
  },

  /*
   * NestJS: `consistent-type-imports` KHÔNG dùng được ở đây.
   *
   * DI của Nest đọc metadata kiểu lúc runtime (`emitDecoratorMetadata`).
   * Chuyển import của một class dùng làm kiểu tham số constructor sang
   * `import type` sẽ xóa value import, khiến `design:paramtypes` không được
   * emit và provider nhận `undefined` — một lỗi runtime im lặng mà typecheck
   * không thể bắt.
   *
   * Đây là tắt rule vì lý do đúng đắn về mặt kỹ thuật, không phải để build cho
   * qua (prompt §21).
   */
  {
    files: ['apps/api/**/*.ts', 'apps/worker/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },

  /* Test được nới lỏng có kiểm soát */
  {
    files: ['**/*.spec.ts', '**/*.test.ts', '**/__tests__/**/*.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
      'no-restricted-properties': 'off',
    },
  },
);
