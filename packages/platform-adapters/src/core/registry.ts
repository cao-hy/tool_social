import type { CapabilityKey, Platform } from '@socialhub/shared';
import type { OptionalAdapterMethod, SocialPlatformAdapter } from './adapter.interface';
import { OPTIONAL_METHOD_CAPABILITY_MAP } from './adapter.interface';
import { capabilityUnsupported } from './platform-error';
import { isSupported } from './capability-table';

export class AdapterNotRegisteredError extends Error {
  constructor(platform: Platform) {
    super(
      `Chưa có adapter cho nền tảng ${platform}. Xem docs/ROADMAP.md Phase 9 để biết thứ tự triển khai.`,
    );
    this.name = 'AdapterNotRegisteredError';
  }
}

/**
 * Nơi duy nhất ánh xạ Platform → adapter.
 *
 * Nhờ có registry, không chỗ nào khác trong hệ thống cần viết
 * `if (platform === 'facebook')` — ARCHITECTURE.md §1 (P2).
 */
export class AdapterRegistry {
  private readonly adapters = new Map<Platform, SocialPlatformAdapter>();

  register(adapter: SocialPlatformAdapter): void {
    this.adapters.set(adapter.platform, adapter);
  }

  has(platform: Platform): boolean {
    return this.adapters.has(platform);
  }

  get(platform: Platform): SocialPlatformAdapter {
    const adapter = this.adapters.get(platform);
    if (!adapter) throw new AdapterNotRegisteredError(platform);
    return adapter;
  }

  getRegisteredPlatforms(): Platform[] {
    return [...this.adapters.keys()];
  }

  /**
   * Lấy adapter và khẳng định nó hỗ trợ capability yêu cầu.
   *
   * Đây là cửa duy nhất mà service NÊN dùng cho các thao tác optional. Nó biến
   * "quên kiểm tra capability" từ một bug im lặng (gọi method undefined → crash
   * khó hiểu) thành một lỗi có thông báo rõ ràng, ánh xạ thẳng sang mã lỗi
   * CAPABILITY_UNSUPPORTED của API.
   */
  requireCapability(platform: Platform, capability: CapabilityKey): SocialPlatformAdapter {
    const adapter = this.get(platform);
    if (!isSupported(adapter.capabilities, capability)) {
      throw capabilityUnsupported(platform, capability);
    }
    return adapter;
  }
}

/**
 * Kiểm tra tính nhất quán giữa CODE và CAPABILITY MATRIX.
 *
 * Hai hướng lệch đều là bug:
 *   • Adapter cài đặt `replyToComment` nhưng matrix nói UNSUPPORTED
 *     → tính năng có thật nhưng bị ẩn khỏi người dùng.
 *   • Matrix nói SUPPORTED nhưng adapter không cài đặt method
 *     → UI hiện nút, người dùng bấm, hệ thống crash.
 *
 * Cái thứ hai nguy hiểm hơn nhiều. Hàm này được test gọi cho mọi adapter đã
 * đăng ký (ARCHITECTURE.md §5.4).
 */
export interface CapabilityMismatch {
  platform: Platform;
  method: OptionalAdapterMethod;
  capability: CapabilityKey;
  problem: 'IMPLEMENTED_BUT_NOT_SUPPORTED' | 'SUPPORTED_BUT_NOT_IMPLEMENTED';
}

export function findCapabilityMismatches(adapter: SocialPlatformAdapter): CapabilityMismatch[] {
  const mismatches: CapabilityMismatch[] = [];

  for (const [method, capability] of Object.entries(OPTIONAL_METHOD_CAPABILITY_MAP) as Array<
    [OptionalAdapterMethod, CapabilityKey]
  >) {
    const implemented = typeof adapter[method] === 'function';
    const supported = isSupported(adapter.capabilities, capability);

    if (implemented && !supported) {
      mismatches.push({
        platform: adapter.platform,
        method,
        capability,
        problem: 'IMPLEMENTED_BUT_NOT_SUPPORTED',
      });
    } else if (!implemented && supported) {
      mismatches.push({
        platform: adapter.platform,
        method,
        capability,
        problem: 'SUPPORTED_BUT_NOT_IMPLEMENTED',
      });
    }
  }

  return mismatches;
}
