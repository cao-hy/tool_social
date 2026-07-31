import { Body, Controller, Get, Inject, Post, Req, UseGuards } from '@nestjs/common';
import {
  checkProxyAwareNetwork,
  createProxyAwareFetch,
  hasOutboundProxyConfigured,
  readProxyConfig,
  writeProxyConfig,
} from '@socialhub/config';
import {
  NETWORK_PROXY_POLICIES,
  summarizeNetworkProxyPolicies,
  type NetworkProxyPolicyItem,
  type ProxyConfig,
} from '@socialhub/shared';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../../common/auth/auth.types';
import { requireMembership, requireUser } from '../../common/auth/request-auth';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RoleGuard } from '../../common/guards/role.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';
import { getRequestId } from '../../common/request-context';
import { AuditService } from '../audit/audit.service';

const updateProxySchema = z
  .object({
    enabled: z.boolean().optional(),
    countryLock: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, 'Country lock phải là mã quốc gia ISO-2, ví dụ US.')
      .transform((value) => value.toUpperCase())
      .nullable()
      .optional(),
  })
  .strict();

type UpdateProxyInput = z.infer<typeof updateProxySchema>;
const proxyAwareFetch = createProxyAwareFetch();

@Controller('workspaces/:workspaceId/system')
@UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
@RequirePermissions('workspace:update')
export class SystemController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get('network')
  async getNetworkStatus() {
    const proxyConfig = readProxyConfig();
    const status = await checkProxyAwareNetwork(proxyConfig, proxyAwareFetch);
    return {
      ...status,
      ip: status.ip ?? 'Unknown',
      country: status.country ?? 'Unknown',
      city: status.city ?? 'Unknown',
      isp: status.isp ?? 'Unknown',
    };
  }

  @Post('proxy')
  async updateProxy(
    @Body(zodPipe(updateProxySchema)) config: UpdateProxyInput,
    @Req() request: FastifyRequest & AuthenticatedRequest,
  ): Promise<ProxyConfig> {
    const current = readProxyConfig();
    const updated = { ...current, ...config };
    writeProxyConfig(updated);
    await this.audit.record({
      ...this.auditContext(request),
      workspaceId: requireMembership(request).workspaceId,
      actorUserId: requireUser(request).id,
      action: 'PROXY_CONFIG_UPDATED',
      resourceType: 'proxy_config',
      resourceId: 'global',
      before: current,
      after: updated,
      metadata: {
        changedFields: changedFields(current, updated),
      },
    });
    return updated;
  }

  @Get('proxy-policy')
  getProxyPolicy(): {
    generatedAt: string;
    proxyConfig: ProxyConfig;
    proxyAvailable: boolean;
    summary: ReturnType<typeof summarizeNetworkProxyPolicies>;
    items: readonly NetworkProxyPolicyItem[];
  } {
    return {
      generatedAt: new Date().toISOString(),
      proxyConfig: readProxyConfig(),
      proxyAvailable: hasOutboundProxy(),
      summary: summarizeNetworkProxyPolicies(),
      items: NETWORK_PROXY_POLICIES,
    };
  }

  private auditContext(request: FastifyRequest) {
    return {
      actorIp: request.ip,
      actorUserAgent: request.headers['user-agent'],
      requestId: getRequestId(request),
    };
  }
}

function changedFields(before: ProxyConfig, after: ProxyConfig): string[] {
  return (['enabled', 'countryLock'] as const).filter((field) => before[field] !== after[field]);
}

function hasOutboundProxy(): boolean {
  return hasOutboundProxyConfigured();
}
