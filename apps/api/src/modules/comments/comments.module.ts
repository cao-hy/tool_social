import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

@Module({
  imports: [AuditModule],
  controllers: [CommentsController],
  providers: [CommentsService],
})
export class CommentsModule {}
