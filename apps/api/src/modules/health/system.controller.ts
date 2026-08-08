import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  OnModuleDestroy,
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
  ProxyRuntimeService,
} from '@socialhub/config';
import {
  NETWORK_PROXY_POLICIES,
  summarizeNetworkProxyPolicies,
  type NetworkProxyPolicyItem,
  type ProxyConfig,
} from '@socialhub/shared';
import {
  decryptToken,
  encryptToken,
  ProxyEndpointValidator,
  ProxyPolicyService,
  RedisProxyPolicyCache,
  type Keyring,
  type MinimalRedisClient,
} from '@socialhub/security';
import dns from 'node:dns/promises';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../../common/auth/auth.types';
import { requireMembership } from '../../common/auth/request-auth';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RoleGuard } from '../../common/guards/role.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { KEYRING } from '../../infrastructure/tokens';
import { AuditService } from '../audit/audit.service';
import { ENV, type ApiEnv } from '../../infrastructure/env.provider';
import { RedisService } from '../../infrastructure/redis/redis.service';

const updateProxySchema = z
  .object({
    enabled: z.boolean().optional(),
    proxyUrl: z
      .string()
      .trim()
      .min(1)
      .refine(isSupportedProxyUrl, 'Proxy URL phải bắt đầu bằng http:// hoặc https://.')
      .nullable()
      .optional(),
    countryLock: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, 'Country lock phải là mã quốc gia ISO-2, ví dụ US.')
      .transform((value) => value.toUpperCase())
      .nullable()
      .optional(),
    configVersion: z
      .number()
      .int()
      .nonnegative(
        'Cần configVersion để tránh race condition (lấy từ configVersion của setting hiện tại)',
      )
      .optional(),
    version: z.number().int().nonnegative().optional(),
  })
  .strict();

type UpdateProxyInput = z.infer<typeof updateProxySchema>;

@Controller('workspaces/:workspaceId/system')
@UseGuards(AuthGuard, WorkspaceGuard, RoleGuard)
@RequirePermissions('workspace:update')
export class SystemController implements OnModuleDestroy {
  private proxyRuntimeInstance?: ProxyRuntimeService;
  private readonly endpointValidator: ProxyEndpointValidator;

  async onModuleDestroy() {
    await this.proxyRuntimeInstance?.closeAll();
  }

  constructor(
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(KEYRING) private readonly keyring: Keyring,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RedisService) private readonly redisService: RedisService,
  ) {
    this.endpointValidator = new ProxyEndpointValidator(dns);
  }

  private get proxyRuntime(): ProxyRuntimeService {
    if (!this.proxyRuntimeInstance) {
      const redisClient = (
        this.redisService?.getClient ? this.redisService.getClient() : {}
      ) as MinimalRedisClient;
      const policyCache = new RedisProxyPolicyCache(redisClient);
      const policyService = new ProxyPolicyService(policyCache, this.env.PROXY_FINGERPRINT_SECRET);
      this.proxyRuntimeInstance = new ProxyRuntimeService(
        policyService,
        this.env.PROXY_FINGERPRINT_SECRET,
      );
    }
    return this.proxyRuntimeInstance;
  }

  @Get('network')
  async getNetworkStatus(@Req() request: FastifyRequest & AuthenticatedRequest) {
    const workspaceId = requireMembership(request).workspaceId;
    const proxyConfig = await this.workspaceProxyConfig(workspaceId);
    let status: Partial<Awaited<ReturnType<typeof checkProxyAwareNetwork>>> = {};
    let prepared: Awaited<ReturnType<typeof this.proxyRuntime.prepareWorkspace>> | undefined;

    try {
      prepared = await this.proxyRuntime.prepareWorkspace(
        workspaceId,
        (id) => this.prisma.workspaceProxySetting.findUnique({ where: { workspaceId: id } }),
        (ciphertext) => decryptToken(ciphertext, this.keyring),
        { forceAttestation: true },
      );

      if (prepared.attestation) {
        status = {
          checkOk: true,
          checkedAt: prepared.attestation.checkedAt,
          ip: prepared.attestation.ip,
          countryCode: prepared.attestation.countryCode,
          country: prepared.attestation.country ?? null,
          city: prepared.attestation.city ?? null,
          isp: prepared.attestation.isp ?? null,
          provider: prepared.attestation.provider,
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
    } finally {
      prepared?.dispatcherHandle?.release();
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

    if (nextStoredProxyUrl) {
      await this.endpointValidator.validate(nextStoredProxyUrl);
    }

    const versionInput = config.configVersion ?? config.version;
    // eslint-disable-next-line no-restricted-properties
    const allowLegacyUpdate = process.env.ALLOW_LEGACY_PROXY_UPDATE_WITHOUT_VERSION === 'true';

    if (currentSetting && versionInput === undefined && !allowLegacyUpdate) {
      throw new HttpException('Missing config version', 400);
    }

    const expectedVersion = versionInput ?? currentSetting?.configVersion;

    const encryptedProxyUrl = nextStoredProxyUrl
      ? encryptToken(nextStoredProxyUrl, this.keyring)
      : null;

    let savedSetting = null;

    if (!currentSetting) {
      if (versionInput !== undefined && versionInput !== 0) {
        throw new HttpException('Config version mismatch on initial creation', 409);
      }

      try {
        savedSetting = await this.prisma.workspaceProxySetting.create({
          data: {
            workspaceId,
            enabled: config.enabled ?? false,
            countryLock: config.countryLock ?? null,
            proxyUrl: encryptedProxyUrl?.ciphertext ?? null,
            proxyUrlMasked: maskProxyUrl(nextStoredProxyUrl),
            configVersion: 1,
          },
        });
      } catch (_error) {
        throw new HttpException('Config version conflict during creation', 409);
      }
    } else {
      const updateResult = await this.prisma.workspaceProxySetting.updateMany({
        where: {
          workspaceId,
          ...(allowLegacyUpdate && versionInput === undefined
            ? {}
            : { configVersion: expectedVersion }),
        },
        data: {
          enabled: config.enabled ?? currentSetting.enabled,
          countryLock:
            config.countryLock === undefined ? currentSetting.countryLock : config.countryLock,
          proxyUrl: encryptedProxyUrl?.ciphertext ?? null,
          proxyUrlMasked: maskProxyUrl(nextStoredProxyUrl),
          configVersion: { increment: 1 },
        },
      });

      if (updateResult.count === 0) {
        throw new HttpException(
          'Cấu hình đã bị thay đổi bởi người khác, vui lòng tải lại trang.',
          409,
        );
      }

      savedSetting = await this.prisma.workspaceProxySetting.findUnique({ where: { workspaceId } });
    }

    if (!savedSetting) {
      throw new HttpException('Không thể lưu cấu hình proxy', 500);
    }

    const nextConfig = resolveWorkspaceProxyConfig(savedSetting, (ciphertext) =>
      decryptToken(ciphertext, this.keyring),
    );

    const changes = changedFields(current, nextConfig);

    await this.audit.record({
      workspaceId,
      actorUserId: requireMembership(request).userId,
      actorIp: request.ip,
      actorUserAgent: request.headers['user-agent'],
      action: 'PROXY_CONFIG_UPDATED',
      resourceType: 'WorkspaceProxySetting',
      resourceId: workspaceId,
      metadata: {
        changes,
        enabled: nextConfig.enabled,
        countryLock: nextConfig.countryLock,
        proxyUrlMasked: nextConfig.proxyUrlMasked,
        source: nextConfig.source,
        configVersion: nextConfig.version,
      },
    });

    response.header('x-proxy-version', String(nextConfig.version ?? 1));
    return publicProxyConfig(nextConfig);
  }

  @Get('proxy-policy')
  async getProxyPolicies(@Req() request: FastifyRequest & AuthenticatedRequest): Promise<{
    policies: NetworkProxyPolicyItem[];
    summary: ReturnType<typeof summarizeNetworkProxyPolicies>;
    proxyConfig: ReturnType<typeof publicProxyConfig>;
    proxyAvailable: boolean;
  }> {
    const proxyConfig = await this.workspaceProxyConfig(requireMembership(request).workspaceId);
    return {
      policies: [...NETWORK_PROXY_POLICIES],
      summary: summarizeNetworkProxyPolicies(),
      proxyConfig: publicProxyConfig(proxyConfig),
      proxyAvailable: Boolean(proxyConfig.proxyUrl),
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
    status: Partial<Awaited<ReturnType<typeof checkProxyAwareNetwork>>>,
  ) {
    if (!status.checkedAt) return;

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
