import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  checkProxyAwareNetwork,
  createDirectFetch,
  maskProxyUrl,
  resolveWorkspaceProxyConfig,
  publicProxyConfig,
} from '@socialhub/config';
import {
  NETWORK_PROXY_POLICIES,
  summarizeNetworkProxyPolicies,
  type NetworkProxyPolicyItem,
  type ProxyConfig,
} from '@socialhub/shared';
import { decryptToken, encryptToken, type Keyring } from '@socialhub/security';
import type { FastifyRequest, FastifyReply } from 'fastify';
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
import { AdapterRegistryFactory } from '../../infrastructure/adapter-registry.factory';

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
    version: z
      .number()
      .int()
      .nonnegative(
        'Cần version để tránh race condition (lấy từ configVersion của setting hiện tại)',
      )
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
    @Inject(AdapterRegistryFactory) private readonly adapterFactory: AdapterRegistryFactory,
  ) {}

  @Get('network')
  async getNetworkStatus(@Req() request: FastifyRequest & AuthenticatedRequest) {
    const workspaceId = requireMembership(request).workspaceId;
    const proxyConfig = await this.workspaceProxyConfig(workspaceId);
    let status: Partial<Awaited<ReturnType<typeof checkProxyAwareNetwork>>> = {};

    try {
      const ctx = await this.adapterFactory.forWorkspace(workspaceId);
      if (ctx.proxy.enabled && ctx.proxy.attestation) {
        status = {
          checkOk: true,
          checkedAt: ctx.proxy.attestation.checkedAt,
          ip: ctx.proxy.attestation.ip,
          countryCode: ctx.proxy.attestation.countryCode,
          provider: ctx.proxy.attestation.provider,
          proxyAvailable: true,
          proxyActive: true,
          countryLockSatisfied: true,
        };
      } else {
        status = await checkProxyAwareNetwork(proxyConfig, createDirectFetch());
      }
    } catch (err: unknown) {
      status = {
        checkOk: false,
        checkedAt: new Date().toISOString(),
        checkError: err instanceof Error ? err.message : String(err),
        proxyAvailable: false,
        proxyActive: false,
        countryLockSatisfied: false,
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await this.rememberLastCheck(workspaceId, status as any);
    return {
      ...status,
      proxyConfig: publicProxyConfig(proxyConfig),
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
    @Res({ passthrough: true }) response: FastifyReply,
  ): Promise<ProxyConfig> {
    const workspaceId = requireMembership(request).workspaceId;
    const current = await this.workspaceProxyConfig(workspaceId);
    const currentSetting = await this.prisma.workspaceProxySetting.findUnique({
      where: { workspaceId },
    });

    const storedProxyUrl = currentSetting?.proxyUrl
      ? decryptToken(currentSetting.proxyUrl, this.keyring)
      : null;

    const nextStoredProxyUrl =
      config.proxyUrl === undefined
        ? storedProxyUrl
        : config.proxyUrl?.trim()
          ? config.proxyUrl.trim()
          : null;

    // eslint-disable-next-line no-restricted-properties
    const allowLegacyUpdate = process.env.ALLOW_LEGACY_PROXY_UPDATE_WITHOUT_VERSION === 'true';

    if (currentSetting && config.version === undefined) {
      if (!allowLegacyUpdate) {
        throw new HttpException('Missing config version', 400);
      }
    } else if (currentSetting && currentSetting.configVersion !== config.version) {
      throw new HttpException(
        'Cấu hình đã bị thay đổi bởi người khác, vui lòng tải lại trang.',
        409,
      );
    }

    const encryptedProxyUrl = nextStoredProxyUrl
      ? encryptToken(nextStoredProxyUrl, this.keyring)
      : null;

    const savedSetting =
      config.version === undefined
        ? await this.prisma.workspaceProxySetting.create({
            data: {
              workspaceId,
              enabled: config.enabled ?? currentSetting?.enabled ?? false,
              countryLock:
                config.countryLock === undefined
                  ? (currentSetting?.countryLock ?? null)
                  : config.countryLock,
              proxyUrl: encryptedProxyUrl?.ciphertext ?? null,
              proxyUrlMasked: maskProxyUrl(nextStoredProxyUrl),
              configVersion: 1,
            },
          })
        : (
              await this.prisma.workspaceProxySetting.updateMany({
                where: { workspaceId, configVersion: config.version },
                data: {
                  enabled: config.enabled ?? currentSetting?.enabled ?? false,
                  countryLock:
                    config.countryLock === undefined
                      ? (currentSetting?.countryLock ?? null)
                      : config.countryLock,
                  proxyUrl: encryptedProxyUrl?.ciphertext ?? null,
                  proxyUrlMasked: maskProxyUrl(nextStoredProxyUrl),
                  configVersion: { increment: 1 },
                },
              })
            ).count > 0
          ? await this.prisma.workspaceProxySetting.findUnique({ where: { workspaceId } })
          : null;

    if (!savedSetting) {
      throw new HttpException(
        'Cấu hình đã bị thay đổi bởi người khác, vui lòng tải lại trang.',
        409,
      );
    }

    const updated = resolveWorkspaceProxyConfig(savedSetting, (ciphertext) =>
      decryptToken(ciphertext, this.keyring),
    );

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

    response.header('X-Proxy-Version', updated.version?.toString() ?? '0');
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
    const setting = await this.prisma.workspaceProxySetting.findUnique({
      where: { workspaceId },
    });

    return resolveWorkspaceProxyConfig(setting, (ciphertext) =>
      decryptToken(ciphertext, this.keyring),
    );
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
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}
