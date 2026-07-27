import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';

@Module({
  imports: [AuditModule],
  controllers: [PostsController],
  providers: [PostsService],
})
export class PostsModule {}
