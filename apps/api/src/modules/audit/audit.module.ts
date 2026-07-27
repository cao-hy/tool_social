import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditLogsService } from './audit-logs.service';
import { AuditService } from './audit.service';

@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditLogsService],
  exports: [AuditService],
})
export class AuditModule {}
