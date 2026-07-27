import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { AuthModule } from './modules/auth/auth.module';
import { CommentsModule } from './modules/comments/comments.module';
import { HealthModule } from './modules/health/health.module';
import { PlatformsModule } from './modules/platforms/platforms.module';
import { MediaModule } from './modules/media/media.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PostsModule } from './modules/posts/posts.module';
import { SocialAccountsModule } from './modules/social-accounts/social-accounts.module';
import { WorkspacesModule } from './modules/workspaces/workspaces.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';

/**
 * Filter và interceptor đăng ký ở đây (chứ không phải trên từng controller) để
 * không controller nào có thể "quên" chúng. Envelope thống nhất và xử lý lỗi
 * tập trung chỉ có giá trị khi chúng KHÔNG THỂ bị bỏ sót.
 *
 * Các module nghiệp vụ (auth, workspaces, posts, comments, analytics...) sẽ được
 * thêm từ Phase 2 trở đi — xem docs/ROADMAP.md.
 */
@Module({
  imports: [
    InfrastructureModule,
    HealthModule,
    PlatformsModule,
    AuthModule,
    WorkspacesModule,
    WebhooksModule,
    SocialAccountsModule,
    MediaModule,
    PostsModule,
    NotificationsModule,
    CommentsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
  ],
})
export class AppModule {}
