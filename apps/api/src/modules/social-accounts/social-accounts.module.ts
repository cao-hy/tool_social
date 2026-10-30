import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SocialAccountsController } from './social-accounts.controller';
import { SocialAccountsService } from './social-accounts.service';
import { StoreIntegrationsService } from './store-integrations.service';

@Module({
  imports: [AuditModule],
  controllers: [SocialAccountsController],
  providers: [SocialAccountsService, StoreIntegrationsService],
})
export class SocialAccountsModule {}
