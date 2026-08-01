import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MediaModule } from '../media/media.module';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';

@Module({
  imports: [AuditModule, MediaModule],
  controllers: [PostsController],
  providers: [PostsService],
})
export class PostsModule {}
