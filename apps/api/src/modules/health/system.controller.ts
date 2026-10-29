import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  OnModuleDestroy,
  Optional,
  Post,
  Query,
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
import { AdapterRegistryFactory } from '../../infrastructure/adapter-registry.factory';
import { EventsService } from '../events/events.service';

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
export class SystemController implements OnModuleDestroy {
  private proxyRuntimeInstance?: ProxyRuntimeService;
  private readonly endpointValidator: ProxyEndpointValidator;
  private directStatusCache?: {
    expiresAt: number;
    data: Awaited<ReturnType<typeof checkProxyAwareNetwork>>;
  };

  async onModuleDestroy() {
    await this.proxyRuntimeInstance?.closeAll();
  }

  constructor(
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(KEYRING) private readonly keyring: Keyring,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RedisService) private readonly redisService: RedisService,
    @Optional()
    @Inject(AdapterRegistryFactory)
    private readonly adapterFactory?: AdapterRegistryFactory,
    @Optional()
    @Inject(EventsService)
    private readonly events?: EventsService,
  ) {
    this.endpointValidator = new ProxyEndpointValidator(dns);
  }

  private get proxyRuntime(): ProxyRuntimeService {
    if (typeof this.adapterFactory?.getProxyRuntime === 'function') {
      return this.adapterFactory.getProxyRuntime();
    }
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
  @RequirePermissions('social_account:view')
  async getNetworkStatus(
    @Req() request: FastifyRequest & AuthenticatedRequest,
    @Query('refresh') refresh?: string,
  ) {
    const workspaceId = requireMembership(request).workspaceId;
    const forceRefresh = refresh === 'true' || refresh === '1';
    const proxyConfig = await this.workspaceProxyConfig(workspaceId);
    const proxyAvailable = Boolean(proxyConfig.proxyUrl);
    let status: Partial<Awaited<ReturnType<typeof checkProxyAwareNetwork>>> = {};
    let prepared: Awaited<ReturnType<typeof this.proxyRuntime.prepareWorkspace>> | undefined;

    if (proxyConfig.enabled && !proxyAvailable) {
      status = {
        checkOk: false,
        checkedAt: new Date().toISOString(),
        checkError: 'Đã bật Proxy nhưng chưa nhập Proxy URL.',
        proxyAvailable: false,
        proxyActive: false,
        countryLockSatisfied: false,
      };
    } else if (!proxyConfig.enabled) {
      const now = Date.now();
      if (!forceRefresh && this.directStatusCache && this.directStatusCache.expiresAt > now) {
        status = {
          ...this.directStatusCache.data,
          proxyAvailable,
          proxyActive: false,
          countryLockSatisfied: true,
        };
      } else {
        const directCheck = await checkProxyAwareNetwork(proxyConfig, createDirectFetch());
        this.directStatusCache = {
          expiresAt: now + 5 * 60 * 1000,
          data: directCheck,
        };
        status = directCheck;
      }
    } else {
      try {
        prepared = await this.proxyRuntime.prepareWorkspace(
          workspaceId,
          (id) => this.prisma.workspaceProxySetting.findUnique({ where: { workspaceId: id } }),
          (ciphertext) => decryptToken(ciphertext, this.keyring),
          { forceAttestation: forceRefresh },
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
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const lockMatch = /^Proxy IP is in ([A-Z]{2}), but country lock requires ([A-Z]{2})/.exec(
          errMsg,
        );
        if (lockMatch) {
          status = {
            checkOk: true,
            checkedAt: new Date().toISOString(),
            countryCode: lockMatch[1],
            country: lockMatch[1],
            checkError: `IP Proxy đang ở ${lockMatch[1]}, không khớp khóa quốc gia ${lockMatch[2]}.`,
            proxyAvailable: true,
            proxyActive: false,
            countryLockSatisfied: false,
          };
        } else {
          status = {
            checkOk: false,
            checkedAt: new Date().toISOString(),
            checkError: errMsg,
            proxyAvailable,
            proxyActive: false,
            countryLockSatisfied: false,
          };
        }
      } finally {
        prepared?.dispatcherHandle?.release();
      }
    }

    if (forceRefresh && status.checkedAt) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await this.rememberLastCheck(workspaceId, status as any);
    }

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
  @RequirePermissions('workspace:update')
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
        savedSetting = await this.prisma.$transaction(async (tx) => {
          const created = await tx.workspaceProxySetting.create({
            data: {
              workspaceId,
              enabled: config.enabled ?? false,
              countryLock: config.countryLock ?? null,
              proxyUrl: encryptedProxyUrl?.ciphertext ?? null,
              proxyUrlMasked: maskProxyUrl(nextStoredProxyUrl),
              configVersion: 1,
            },
          });
          await tx.workspace.update({
            where: { id: workspaceId },
            data: {
              socialEgressPolicy: created.enabled ? 'PROXY_REQUIRED' : 'DIRECT_ALLOWED',
            },
          });
          return created;
        });
      } catch (_error) {
        throw new HttpException('Config version conflict during creation', 409);
      }
    } else {
      const nextEnabled = config.enabled ?? currentSetting.enabled;
      const updateResult = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.workspaceProxySetting.updateMany({
          where: {
            workspaceId,
            ...(allowLegacyUpdate && versionInput === undefined
              ? {}
              : { configVersion: expectedVersion }),
          },
          data: {
            enabled: nextEnabled,
            countryLock:
              config.countryLock === undefined ? currentSetting.countryLock : config.countryLock,
            proxyUrl: encryptedProxyUrl?.ciphertext ?? null,
            proxyUrlMasked: maskProxyUrl(nextStoredProxyUrl),
            configVersion: { increment: 1 },
          },
        });
        if (updated.count === 1) {
          await tx.workspace.update({
            where: { id: workspaceId },
            data: {
              socialEgressPolicy: nextEnabled ? 'PROXY_REQUIRED' : 'DIRECT_ALLOWED',
            },
          });
        }
        return updated;
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

    this.directStatusCache = undefined;
    this.events?.publish(workspaceId, { type: 'network.changed' });
    response.header('x-proxy-version', String(nextConfig.version ?? 1));
    return publicProxyConfig(nextConfig);
  }

  @Get('proxy-policy')
  @RequirePermissions('social_account:view')
  async getProxyPolicies(@Req() request: FastifyRequest & AuthenticatedRequest): Promise<{
    generatedAt: string;
    items: NetworkProxyPolicyItem[];
    policies: NetworkProxyPolicyItem[];
    summary: ReturnType<typeof summarizeNetworkProxyPolicies>;
    proxyConfig: ReturnType<typeof publicProxyConfig>;
    proxyAvailable: boolean;
  }> {
    const proxyConfig = await this.workspaceProxyConfig(requireMembership(request).workspaceId);
    const items = [...NETWORK_PROXY_POLICIES];
    return {
      generatedAt: new Date().toISOString(),
      items,
      policies: items,
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
