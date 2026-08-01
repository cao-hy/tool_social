import { Body, Controller, Get, Inject, Post, Req, UseGuards } from '@nestjs/common';
import {
  checkProxyAwareNetwork,
  createProxyAwareFetch,
  getConfiguredProxyUrl,
  maskProxyUrl,
  normalizeProxyConfig,
  proxyConfigFromWorkspaceSetting,
  publicProxyConfig,
  readProxyConfig,
} from '@socialhub/config';
import {
  NETWORK_PROXY_POLICIES,
  summarizeNetworkProxyPolicies,
  type NetworkProxyPolicyItem,
  type ProxyConfig,
} from '@socialhub/shared';
import { decryptToken, encryptToken, type Keyring } from '@socialhub/security';
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
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { KEYRING } from '../../infrastructure/tokens';
import { AuditService } from '../audit/audit.service';

const updateProxySchema = z
  .object({
    enabled: z.boolean().optional(),
    proxyUrl: z
      .string()
      .trim()
      .min(1)
      .refine(isSupportedProxyUrl, 'Proxy URL phải bắt đầu bằng http://, https:// hoặc socks5://.')
      .nullable()
      .optional(),
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

@Controller('workspaces/:workspaceId/system')
@UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
@RequirePermissions('workspace:update')
export class SystemController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(KEYRING) private readonly keyring: Keyring,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get('network')
  async getNetworkStatus(@Req() request: FastifyRequest & AuthenticatedRequest) {
    const workspaceId = requireMembership(request).workspaceId;
    const proxyConfig = await this.workspaceProxyConfig(workspaceId);
    const status = await checkProxyAwareNetwork(proxyConfig, createProxyAwareFetch(proxyConfig));
    await this.rememberLastCheck(workspaceId, status);
    return {
      ...status,
      proxyConfig: publicProxyConfig(status.proxyConfig),
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
    const workspaceId = requireMembership(request).workspaceId;
    const current = await this.workspaceProxyConfig(workspaceId);
    const currentSetting = await this.prisma.workspaceProxySetting.findUnique({
      where: { workspaceId },
    });
    const nextProxyUrl =
      config.proxyUrl === undefined
        ? (current.proxyUrl ?? null)
        : config.proxyUrl?.trim()
          ? config.proxyUrl.trim()
          : null;
    const encryptedProxyUrl = nextProxyUrl ? encryptToken(nextProxyUrl, this.keyring) : null;
    const updated = normalizeProxyConfig({
      enabled: config.enabled ?? current.enabled,
      countryLock: config.countryLock === undefined ? current.countryLock : config.countryLock,
      proxyUrl: nextProxyUrl,
      proxyUrlMasked: maskProxyUrl(nextProxyUrl),
      source: nextProxyUrl ? 'WORKSPACE' : 'DIRECT',
    });

    await this.prisma.workspaceProxySetting.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        enabled: updated.enabled,
        countryLock: updated.countryLock,
        proxyUrl: encryptedProxyUrl?.ciphertext,
        proxyUrlMasked: updated.proxyUrlMasked,
      },
      update: {
        enabled: updated.enabled,
        countryLock: updated.countryLock,
        proxyUrl:
          config.proxyUrl === undefined
            ? currentSetting?.proxyUrl
            : (encryptedProxyUrl?.ciphertext ?? null),
        proxyUrlMasked:
          config.proxyUrl === undefined ? currentSetting?.proxyUrlMasked : updated.proxyUrlMasked,
      },
    });

    await this.audit.record({
      ...this.auditContext(request),
      workspaceId,
      actorUserId: requireUser(request).id,
      action: 'PROXY_CONFIG_UPDATED',
      resourceType: 'WorkspaceProxySetting',
      resourceId: workspaceId,
      before: publicProxyConfig(current),
      after: publicProxyConfig(updated),
      metadata: {
        changedFields: changedFields(current, updated),
      },
    });
    return publicProxyConfig(updated);
  }

  @Get('proxy-policy')
  async getProxyPolicy(@Req() request: FastifyRequest & AuthenticatedRequest): Promise<{
    generatedAt: string;
    proxyConfig: ProxyConfig;
    proxyAvailable: boolean;
    summary: ReturnType<typeof summarizeNetworkProxyPolicies>;
    items: readonly NetworkProxyPolicyItem[];
  }> {
    const proxyConfig = await this.workspaceProxyConfig(requireMembership(request).workspaceId);
    return {
      generatedAt: new Date().toISOString(),
      proxyConfig: publicProxyConfig(proxyConfig),
      proxyAvailable: Boolean(proxyConfig.proxyUrl),
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

  private async workspaceProxyConfig(workspaceId: string): Promise<ProxyConfig> {
    const setting = await this.prisma.workspaceProxySetting.findUnique({ where: { workspaceId } });
    if (!setting) {
      const envProxyUrl = getConfiguredProxyUrl();
      return normalizeProxyConfig({
        ...readProxyConfig(),
        enabled: false,
        proxyUrl: envProxyUrl,
        proxyUrlMasked: maskProxyUrl(envProxyUrl),
        source: envProxyUrl ? 'ENV' : 'DIRECT',
      });
    }

    const config = proxyConfigFromWorkspaceSetting(setting, (ciphertext) =>
      decryptToken(ciphertext, this.keyring),
    );
    if (!config.proxyUrl) {
      const envProxyUrl = getConfiguredProxyUrl();
      return normalizeProxyConfig({
        ...config,
        proxyUrl: envProxyUrl,
        proxyUrlMasked: maskProxyUrl(envProxyUrl),
        source: envProxyUrl ? 'ENV' : 'DIRECT',
      });
    }
    return config;
  }

  private async rememberLastCheck(
    workspaceId: string,
    status: Awaited<ReturnType<typeof checkProxyAwareNetwork>>,
  ) {
    await this.prisma.workspaceProxySetting.updateMany({
      where: { workspaceId },
      data: {
        lastCheckedAt: new Date(status.checkedAt),
        lastCheckStatus: status.checkOk ? 'OK' : 'FAILED',
        lastIp: status.ip,
        lastCountryCode: status.countryCode,
        lastCheckError: status.checkError,
      },
    });
  }
}

function changedFields(before: ProxyConfig, after: ProxyConfig): string[] {
  return (['enabled', 'countryLock', 'proxyUrlMasked'] as const).filter(
    (field) => before[field] !== after[field],
  );
}

function isSupportedProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'socks:', 'socks5:'].includes(url.protocol);
  } catch {
    return false;
  }
}
