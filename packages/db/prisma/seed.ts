/**
 * Seed data cho LOCAL DEVELOPMENT — prompt §19.
 *
 * Ranh giới quan trọng (prompt §21):
 *  • Seed tạo user, workspace, thành viên, draft và media giả — những thứ nằm
 *    hoàn toàn trong hệ thống của chúng ta.
 *  • Seed KHÔNG tạo SocialAccount hay SocialToken giả. Một social account giả
 *    sẽ khiến UI trông như đã kết nối thành công trong khi không có gì kết nối
 *    cả, và mọi job chạm vào nó sẽ thất bại theo cách khó hiểu. Muốn có social
 *    account thì phải chạy luồng OAuth thật với credential thật.
 *  • Seed KHÔNG tạo metric giả. Số liệu bịa đặt trên dashboard là cách nhanh
 *    nhất để tự lừa mình rằng integration đã hoạt động.
 *
 * Script từ chối chạy khi NODE_ENV=production.
 */

import { PrismaClient } from '../generated/client';

const prisma = new PrismaClient();

const DEV_PASSWORD_HASH_PLACEHOLDER =
  '$argon2id$v=19$m=65536,t=3,p=4$PLACEHOLDER_REPLACE_ON_FIRST_LOGIN';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Seed không được chạy ở production.');
  }

  console.warn('▶ Seeding local development data…');

  const owner = await prisma.user.upsert({
    where: { email: 'owner@localhost.dev' },
    update: {},
    create: {
      email: 'owner@localhost.dev',
      name: 'Local Owner',
      passwordHash: DEV_PASSWORD_HASH_PLACEHOLDER,
      emailVerified: new Date(),
    },
  });

  const editor = await prisma.user.upsert({
    where: { email: 'editor@localhost.dev' },
    update: {},
    create: {
      email: 'editor@localhost.dev',
      name: 'Local Editor',
      passwordHash: DEV_PASSWORD_HASH_PLACEHOLDER,
      emailVerified: new Date(),
    },
  });

  const viewer = await prisma.user.upsert({
    where: { email: 'viewer@localhost.dev' },
    update: {},
    create: {
      email: 'viewer@localhost.dev',
      name: 'Local Viewer',
      passwordHash: DEV_PASSWORD_HASH_PLACEHOLDER,
      emailVerified: new Date(),
    },
  });

  const workspace = await prisma.workspace.upsert({
    where: { slug: 'local-dev' },
    update: {},
    create: {
      name: 'Local Dev Workspace',
      slug: 'local-dev',
      timezone: 'Asia/Ho_Chi_Minh',
    },
  });

  // Ba vai trò khác nhau để test được ma trận quyền ngay từ local.
  for (const [user, role] of [
    [owner, 'OWNER'],
    [editor, 'EDITOR'],
    [viewer, 'VIEWER'],
  ] as const) {
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
      update: { role },
      create: { workspaceId: workspace.id, userId: user.id, role },
    });
  }

  // Workspace thứ hai với CHỈ owner làm thành viên — dùng để test luồng
  // "user của workspace A không được thấy dữ liệu workspace B" (E2E #14).
  const otherWorkspace = await prisma.workspace.upsert({
    where: { slug: 'other-tenant' },
    update: {},
    create: { name: 'Other Tenant', slug: 'other-tenant', timezone: 'UTC' },
  });

  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: otherWorkspace.id, userId: owner.id } },
    update: { role: 'OWNER' },
    create: { workspaceId: otherWorkspace.id, userId: owner.id, role: 'OWNER' },
  });

  const existingDraft = await prisma.contentPost.findFirst({
    where: { workspaceId: workspace.id, title: 'Draft mẫu cho local dev' },
  });

  if (!existingDraft) {
    await prisma.contentPost.create({
      data: {
        workspaceId: workspace.id,
        createdById: owner.id,
        status: 'DRAFT',
        title: 'Draft mẫu cho local dev',
        body: 'Đây là draft do seed tạo ra. Chưa gắn với social account nào vì chưa có kết nối thật.',
        hashtags: ['socialhub', 'demo'],
      },
    });
  }

  await prisma.commentTag.upsert({
    where: { workspaceId_name: { workspaceId: workspace.id, name: 'Cần xử lý gấp' } },
    update: {},
    create: { workspaceId: workspace.id, name: 'Cần xử lý gấp', color: '#dc2626' },
  });

  await prisma.replyTemplate.upsert({
    where: { workspaceId_name: { workspaceId: workspace.id, name: 'Cảm ơn' } },
    update: {},
    create: {
      workspaceId: workspace.id,
      name: 'Cảm ơn',
      body: 'Cảm ơn bạn đã quan tâm! Chúng tôi sẽ phản hồi sớm nhất có thể.',
    },
  });

  console.warn('✔ Seed xong.');
  console.warn('');
  console.warn('  Tài khoản dev:');
  console.warn('    owner@localhost.dev   (OWNER)');
  console.warn('    editor@localhost.dev  (EDITOR)');
  console.warn('    viewer@localhost.dev  (VIEWER)');
  console.warn('');
  console.warn('  Mật khẩu: CHƯA đặt. Dùng luồng "quên mật khẩu" sau khi Phase 2 xong,');
  console.warn('  hoặc đăng ký tài khoản mới. Seed cố ý không đặt mật khẩu thật.');
  console.warn('');
  console.warn('  KHÔNG có social account nào được seed — kết nối thật qua OAuth mới có.');
}

main()
  .catch((error: unknown) => {
    console.error('✖ Seed thất bại:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
