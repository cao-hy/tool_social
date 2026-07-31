import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { SystemController } from './system.controller';

@Module({
  imports: [AuditModule],
  controllers: [HealthController, SystemController],
  providers: [HealthService],
})
export class HealthModule {}
