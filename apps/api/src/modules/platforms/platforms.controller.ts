import { Controller, Get } from '@nestjs/common';
import {
  CAPABILITY_MATRIX,
  getVerificationProgress,
  POLICY_EXCLUDED_ACTIONS,
  POLICY_EXCLUSION_REASON,
} from '@socialhub/platform-adapters';
import { PLATFORM_LABELS } from '@socialhub/shared';

/**
 * Capability matrix cho frontend — ARCHITECTURE.md §1 (P4).
 *
 * Đây là endpoint khiến giới hạn của các nền tảng trở thành thứ NHÌN THẤY ĐƯỢC
 * trong sản phẩm thay vì một dòng ghi chú trong tài liệu. UI dùng nó để ẩn hoặc
 * disable tính năng TRƯỚC khi người dùng bấm, thay vì báo lỗi sau khi bấm.
 *
 * Ở Phase 1, mọi capability đều UNVERIFIED — nên UI sẽ ẩn hết tính năng nền
 * tảng. Đó là hành vi đúng: chưa ai kiểm chứng thì hệ thống không hứa.
 */
@Controller('platforms')
export class PlatformsController {
  @Get('capabilities')
  getCapabilities(): unknown {
    return {
      platforms: Object.entries(CAPABILITY_MATRIX).map(([platform, table]) => ({
        platform,
        label: PLATFORM_LABELS[platform as keyof typeof PLATFORM_LABELS],
        capabilities: table.capabilities,
        limits: table.limits,
      })),
      verificationProgress: getVerificationProgress(),
      policyExcludedActions: {
        actions: POLICY_EXCLUDED_ACTIONS,
        reason: POLICY_EXCLUSION_REASON,
      },
    };
  }
}
